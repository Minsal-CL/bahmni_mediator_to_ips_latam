// index.js (FHIR Event Forwarder Mediator) — Contrarreferencia (respuesta a Interconsulta)
// Toma el Encounter del formulario "Contrarreferencia" (una obs de texto = Resultado de la Evaluación),
// arma el documento MHD (Composition LACCompositionIT + Document Bundle + DocumentReference + List) y lo
// POSTea como transacción MHD (ITI-65) al nodo nacional. Enlaza (best-effort) al ServiceRequest activo del
// paciente (context.related), que se resuelve igual que el dashboard/IPS. IG RACSEL Interconsulta Transfronteriza.
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

// Carpeta donde se deja una copia del bundle MHD enviado (evidencia connectathon)
const MHD_DUMP_DIR = process.env.MHD_DUMP_DIR || '/tmp'
function dumpBundle(kind, id, data) {
  try {
    fs.mkdirSync(MHD_DUMP_DIR, { recursive: true })
    const file = path.join(MHD_DUMP_DIR, `mhd_${kind}_${id}_${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    console.log(new Date().toISOString(), '💾 Bundle MHD guardado:', file)
  } catch (e) { console.warn('⚠️ No se pudo guardar el bundle MHD:', e.message) }
}
// Registro de orquestación para que OpenHIM muestre cada llamada saliente en la transacción
function mkOrch(name, method, url, reqBody, res) {
  const safe = v => { try { return typeof v === 'string' ? v : JSON.stringify(v) } catch { return '' } }
  return {
    name,
    request:  { method, path: url, body: safe(reqBody), timestamp: new Date().toISOString() },
    response: { status: res?.status || 0, body: safe(res?.data), timestamp: new Date().toISOString() }
  }
}
// Headers CORS para el origin dado (allowlist CORS_ORIGIN). OpenHIM reconstruye la respuesta al
// browser desde response.headers, así que hay que inyectarlos aquí (no basta el middleware).
function corsHeadersFor(origin) {
  if (!origin) return {}
  const allow = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean)
  if (allow.length === 0 || allow.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' }
  }
  return {}
}
function sendOpenhim(res, summary, orchestrations, origin) {
  res.set('Content-Type', 'application/json+openhim')
  res.send(JSON.stringify({
    'x-mediator-urn': mediatorConfig.urn,
    status: 'Successful',
    response: { status: 200, headers: { 'content-type': 'application/json', ...corsHeadersFor(origin) }, body: JSON.stringify(summary), timestamp: new Date().toISOString() },
    orchestrations: orchestrations || []
  }))
}

// --- OpenHIM config ---
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL:   process.env.OPENHIM_API_URL || process.env.OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
}

const devAgent = new https.Agent({ rejectUnauthorized: false })
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = devAgent
  console.log('⚠️  DEV MODE: self-signed certs accepted')
}

function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

// Crea o ACTUALIZA el canal en OpenHIM. Si ya existe, hace PUT para que cambios de config
// (ej. passThroughHeaders para CORS) tomen efecto al redeploy — antes se saltaba y no se aplicaban.
async function upsertChannel(ch) {
  const auth = { username: openhimConfig.username, password: openhimConfig.password }
  const body = { ...ch, mediator_urn: mediatorConfig.urn }
  try {
    await axios.post(`${openhimConfig.apiURL}/channels`, body, { auth })
    console.log(`✅ Channel created: ${ch.name}`)
  } catch (e) {
    const msg = String(e?.response?.data || e?.message || e)
    const isDup = msg.toLowerCase().includes('duplicate') || e?.response?.status === 409
    if (!isDup) { console.error(`❌ Channel ${ch.name} error:`, msg); return }
    try {
      const list = await axios.get(`${openhimConfig.apiURL}/channels`, { auth })
      const existing = (list.data || []).find(c => c.name === ch.name)
      const id = existing && (existing._id || existing.id || existing.channelId || existing._uid)
      if (id) {
        await axios.put(`${openhimConfig.apiURL}/channels/${id}`, body, { auth })
        console.log(`♻️ Channel updated: ${ch.name}`)
      } else {
        console.log(`ℹ️ Channel already exists but could not determine id: ${ch.name}`)
      }
    } catch (e2) {
      console.error(`❌ Channel ${ch.name} update error:`, String(e2?.response?.data || e2?.message || e2))
    }
  }
}

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) { console.error('❌ Registration error:', err); process.exit(1) }
  console.log('✅ Forwarder Contrarreferencia registered')
  Promise.all((mediatorConfig.defaultChannelConfig || []).map(upsertChannel))
    .then(() => { console.log('✅ All channels processed'); activateHeartbeat(openhimConfig) })
})

const app = express()
app.use(express.json({ limit: '20mb' }))
// CORS: el dashboard (browser) llama /_answer directo. Mismo patrón que los mediadores que ya
// funcionan (DCV-ICVP, lacpass): reflejar el origin del allowlist CORS_ORIGIN + Allow-Credentials.
// (Con credenciales/Authorization NO se puede usar '*': hay que devolver el origin exacto.)
const CORS_ALLOW = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') logStep('🔎 OPTIONS preflight | origin:', origin || '(sin origin)', '| path:', req.originalUrl)
  if (origin && (CORS_ALLOW.length === 0 || CORS_ALLOW.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-OpenHIM-ClientID')
  res.setHeader('Access-Control-Expose-Headers', 'X-OpenHIM-TransactionID')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ============================================================================
// Configuración de mapeo (UUID del formulario "Contrarreferencia")
// ============================================================================
const CONCEPT = {
  // Text -> section[55112-7].text (Resultado de la Evaluación). Es la llave de disparo del mediador.
  EVAL: process.env.CR_CONCEPT_EVAL || '931c9e9c-5cb5-4f74-b7c3-e9952b9ac101'
}

// ── Documento MHD "Contrarreferencia" (respuesta, IG RACSEL Interconsulta) ──
// Un solo servidor FHIR: el nodo NACIONAL (por ahora). Ahí se POSTea la transacción MHD (ITI-65) y
// ahí se resuelve el ServiceRequest activo del paciente para el enlace de vuelta (context.related).
const MHD_ENDPOINT = (process.env.CR_MHD_ENDPOINT || '').replace(/\/$/, '')     // hapinacional/fhir
// Base FHIR nacional (= MHD_ENDPOINT) para buscar el ServiceRequest y (best-effort) registrar el Patient.
const NATIONAL_FHIR_BASE = (process.env.CR_NATIONAL_FHIR_BASE || MHD_ENDPOINT).replace(/\/$/, '')

// Perfiles IG RACSEL "Interconsulta Transfronteriza" (variante IT = respuesta)
const PROFILE_COMP    = process.env.CR_COMPOSITION_PROFILE || 'http://racsel.org/StructureDefinition/LACCompositionIT'
const PROFILE_DOCBNDL = process.env.CR_DOCBUNDLE_PROFILE   || 'http://racsel.org/StructureDefinition/LACBundleDocIT'
const PROFILE_DOCREF  = process.env.CR_DOCREF_PROFILE      || 'http://racsel.org/StructureDefinition/LACDocReferenceIT'
const PROFILE_TXBNDL  = process.env.CR_TXBUNDLE_PROFILE    || 'http://racsel.org/StructureDefinition/LACBundleTransactionMHDIT'
const PROFILE_ORG_LAC = process.env.CR_ORG_PROFILE_URL     || 'http://racsel.org/StructureDefinition/LACOrganization'
// Composition: nota de interconsulta (Consultation note) con la única sección obligatoria del perfil.
const DOCREF_TYPE   = { system: 'http://loinc.org', code: '57133-1', display: 'Referral note' }
// LACCompositionIT FIJA el display en 'Consultation note' (pattern MANDATORY). El validador de
// terminología prefiere 'Consult note' pero eso es solo RECOMMENDED: manda el pattern fijo del perfil.
const COMP_TYPE     = { system: 'http://loinc.org', code: '11488-4', display: 'Consultation note' }
const SECTION_CODE  = { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' }
const SECTION_TITLE = 'Resultado de la Evaluación'
const MASTER_ID_SYSTEM   = process.env.CR_MASTER_ID_SYSTEM   || 'urn:ietf:rfc:3986'
// Organización DESTINO (autor de la contrarreferencia = el especialista que responde). En dev = CL.
const AUTHOR_ORG_NAME    = process.env.CR_AUTHOR_ORG_NAME    || 'Hospital Clínico San Borja Arriarán'
const AUTHOR_ORG_COUNTRY = process.env.CR_AUTHOR_ORG_COUNTRY || 'CL'
// Perfiles adicionales requeridos por la validación RACSEL del MHD
const PROFILE_LIST    = process.env.CR_LIST_PROFILE    || 'http://racsel.org/StructureDefinition/LACList'
const PROFILE_PATIENT = process.env.CR_PATIENT_PROFILE || 'http://racsel.org/StructureDefinition/LACPatient'
// LACPatient exige slices identifier: national (type v2-0203#NI) e international (type v2-0203#PPN),
// con system = URN OID (constraint lac-pat-2). OIDs configurables (defaults = Chile / pasaporte LAC).
const V2_0203     = 'http://terminology.hl7.org/CodeSystem/v2-0203'
// OJO: el separador es PUNTO ('urn:oid.'), no dos puntos, para satisfacer la constraint lac-pat-2 del IG
// (startsWith('urn:oid.2.16.'))  — es lo mismo que hace el mediador ITI-65 del IPS (toUrnOid con ".").
const NAT_ID_OID  = process.env.CR_NATIONAL_ID_OID || 'urn:oid.2.16.152'
const PPN_ID_OID  = process.env.CR_PASSPORT_ID_OID || 'urn:oid.2.16.840.1.113883.4.330.152'
const NAT_ID_CODE = process.env.CR_NATIONAL_ID_TYPE_CODE || 'NI' // National unique individual identifier
// SubmissionSet (LACList): code fijo + extensión sourceId (1..1, identificador del publicador)
const MHD_LIST_CODE_SYSTEM = 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes'
const SOURCE_ID_EXT = 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId'
const CR_SOURCE_ID  = process.env.CR_SOURCE_ID || 'urn:oid:2.16.152' // OID nodo Chile (ajustable)

// Resolución del ServiceRequest (enlace de vuelta). Identificadores del paciente en orden: RUN/RUT, Pasaporte.
const SR_STATUS_FILTER      = process.env.CR_SR_STATUS_FILTER    || 'active'
const NATIONAL_ID_TYPE_TEXT = process.env.CR_NATIONAL_ID_TYPE_TEXT || 'Patient Identifier'
const PASSPORT_ID_TYPE_TEXT = process.env.CR_PASSPORT_ID_TYPE_TEXT || 'Pasaporte'
// Registrar (best-effort) el Patient en el NN para que la búsqueda por patient.identifier resuelva el documento.
const REGISTER_PATIENT = (process.env.CR_REGISTER_PATIENT || 'true').toLowerCase() === 'true'

// ============================================================================
// Fuentes (proxy FHIR de OpenMRS)
// ============================================================================
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

// Normaliza los identifier del Patient a la forma canónica LAC (idempotente: reconoce
// tanto el shape crudo de OpenMRS como el ya normalizado, para que un PUT repetido no lo altere).
function normalizePatientIdentifiers(patient) {
  if (!Array.isArray(patient?.identifier)) return

  const getOid = (envVar, defaultVal) => {
    const val = process.env[envVar] || defaultVal
    return val.startsWith('urn:oid.') ? val : (val.startsWith('urn:oid:') ? val.replace(':', '.') : `urn:oid.${val}`)
  }
  const natOid = getOid('LAC_NATIONAL_ID_SYSTEM_OID', '2.16.152')
  const ppnOid = getOid('LAC_PASSPORT_ID_SYSTEM_OID', '2.16.840.1.113883.4.330.152')

  patient.identifier.forEach(id => {
    const text = id.type?.text || ''
    const code = id.type?.coding?.[0]?.code || ''
    const isNational = text === 'Patient Identifier' || code === 'NI'
    const isPassport = text === 'Pasaporte' || code === 'PPN'

    if (isNational) {
      id.type = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NI' }], text: 'Patient Identifier' }
      id.system = natOid
    } else if (isPassport) {
      id.type = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN' }] }
      id.use = 'official'
      id.system = ppnOid
    }
  })
}

// PUT best-effort del Patient al nodo nacional (para discoverabilidad por patient.identifier).
async function putPatientToNational(patient, orch) {
  if (!REGISTER_PATIENT || !NATIONAL_FHIR_BASE) return
  const url = `${NATIONAL_FHIR_BASE}/Patient/${patient.id}`
  try {
    logStep('PUT (NN Patient)', url)
    const r = await axios.put(url, patient, {
      headers: { 'Content-Type': 'application/fhir+json' },
      validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
    })
    if (orch) orch.push(mkOrch(`PUT Patient/${patient.id}`, 'PUT', url, patient, r))
    if (r.status >= 400) logStep('⚠️ No se pudo registrar Patient en NN:', r.status)
    else logStep('✅ Patient en NN', r.status)
  } catch (e) { logStep('⚠️ Error registrando Patient en NN:', e.message) }
}

// ============================================================================
// Helpers de extracción de observaciones
// ============================================================================
function codeList(r) { return (r?.code?.coding || []).map(c => c.code).filter(Boolean) }
function obsHasConcept(o, uuid) { return codeList(o).includes(uuid) }
function obsValueString(o) {
  if (!o) return undefined
  if (typeof o.valueString === 'string') return o.valueString
  if (o.valueCodeableConcept) return o.valueCodeableConcept.text || o.valueCodeableConcept.coding?.[0]?.display
  return undefined
}
function firstByConcept(observations, uuid) { return observations.find(o => obsHasConcept(o, uuid)) }
function pickEffective(observations, enc) {
  for (const o of observations) { if (o.effectiveDateTime) return o.effectiveDateTime; if (o.issued) return o.issued }
  return enc.period?.start || enc.period?.end || undefined
}
// Identificadores candidatos (RUN/RUT, luego Pasaporte, luego el resto), limpiando prefijos "rut*"/"RUN*".
function patientSearchIdentifiers(patient) {
  const ids = Array.isArray(patient?.identifier) ? patient.identifier : []
  const byType = t => ids.filter(id => (id.type?.text || '') === t).map(id => id.value)
  const ordered = [...byType(NATIONAL_ID_TYPE_TEXT), ...byType(PASSPORT_ID_TYPE_TEXT), ...ids.map(id => id.value)]
  const clean = v => String(v || '').replace(/^[A-Za-z]+\*/, '').trim()
  return [...new Set(ordered.map(clean).filter(Boolean))]
}

// ============================================================================
// Resolución del ServiceRequest activo del paciente (enlace de vuelta, best-effort)
// ============================================================================
async function queryActiveServiceRequest(identifier) {
  const url = `${NATIONAL_FHIR_BASE}/ServiceRequest` +
    `?patient.identifier=${encodeURIComponent(identifier)}&status=${SR_STATUS_FILTER}&_sort=-authoredOn&_count=1`
  logStep('SR GET', url)
  const r = await axios.get(url, {
    headers: { Accept: 'application/fhir+json' },
    validateStatus: false, timeout: 15000, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (r.status >= 400) { logStep('⚠️ SR status', r.status, 'para', identifier); return undefined }
  const sr = (r.data?.entry || [])[0]?.resource
  if (!sr || sr.resourceType !== 'ServiceRequest') return undefined
  return { reference: `ServiceRequest/${sr.id}`, id: sr.id, identifier: sr.identifier }
}
// Prueba cada identificador del paciente hasta encontrar un ServiceRequest activo.
async function resolveServiceRequest(patient) {
  const candidates = patientSearchIdentifiers(patient)
  if (!candidates.length) { logStep('ⓘ Paciente sin identificadores para resolver el SR'); return undefined }
  for (const id of candidates) {
    try { const hit = await queryActiveServiceRequest(id); if (hit) return hit }
    catch (e) { logStep('⚠️ Error resolviendo SR (silenciado) para', id, ':', e?.message || e) }
  }
  logStep('ⓘ Sin ServiceRequest activo para', candidates.join(', '))
  return undefined
}

// ============================================================================
// Documento MHD: Composition (LACCompositionIT) + Document Bundle + DocumentReference + List → transacción
// ============================================================================
function buildAuthorOrg() {
  return { resourceType: 'Organization', meta: { profile: [PROFILE_ORG_LAC] }, name: AUTHOR_ORG_NAME, address: [{ country: AUTHOR_ORG_COUNTRY }] }
}

// Escapa el texto para incrustarlo en el div XHTML de la narrativa.
function escXhtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Mapea un identifier de OpenMRS a un slice LACPatient (national o international), con system=URN OID
// y type coding v2-0203 (sin type.text, que el perfil no permite en el slice).
function lacIdentifier(id) {
  const txt = (id && id.type && id.type.text || '').toLowerCase()
  const cod = (id && id.type && Array.isArray(id.type.coding) ? id.type.coding.map(c => String(c && c.code || '')) : [])
  const isPassport = /pasaporte|passport|ppn/.test(txt) || cod.some(c => c.toUpperCase() === 'PPN')
  if (isPassport) {
    return { use: 'official', system: PPN_ID_OID, type: { coding: [{ system: V2_0203, code: 'PPN' }] }, value: id.value }
  }
  return { use: 'usual', system: NAT_ID_OID, type: { coding: [{ system: V2_0203, code: NAT_ID_CODE }] }, value: id.value }
}

// Patient conforme a LACPatient: limpia extensiones OpenMRS y reconstruye los identifier en los slices
// national + international (ambos requeridos), con system=URN OID.
function sanitizePatientForLac(patient) {
  const names = (patient.name || []).map(n => ({
    ...(n.use ? { use: n.use } : {}),
    ...(n.family ? { family: n.family } : {}),
    ...(Array.isArray(n.given) ? { given: n.given } : {}),
    ...(n.text ? { text: n.text } : {})
  }))
  const raw = (Array.isArray(patient.identifier) ? patient.identifier : []).filter(id => id && id.value)
  let ids = raw.map(lacIdentifier)
  // Asegurar AMBOS slices (national + international); si falta uno, se deriva del primer valor disponible.
  const anyVal = ids.length ? ids[0].value : (patient.id || 'UNKNOWN')
  if (!ids.some(i => i.system === NAT_ID_OID)) {
    ids.unshift({ use: 'usual', system: NAT_ID_OID, type: { coding: [{ system: V2_0203, code: NAT_ID_CODE }] }, value: anyVal })
  }
  if (!ids.some(i => i.system === PPN_ID_OID)) {
    ids.push({ use: 'official', system: PPN_ID_OID, type: { coding: [{ system: V2_0203, code: 'PPN' }] }, value: anyVal })
  }
  return {
    resourceType: 'Patient',
    id: patient.id,
    meta: { profile: [PROFILE_PATIENT] },
    identifier: ids,
    ...(names.length ? { name: names } : {}),
    ...(patient.gender ? { gender: patient.gender } : {}),
    ...(patient.birthDate ? { birthDate: patient.birthDate } : {})
  }
}

// Composition (LACCompositionIT). El Organization autor va CONTENIDO (LACBundleDocIT solo admite
// Composition + Patient como entradas). Referencias internas del documento = urn:uuid absolutas.
function buildComposition({ patientUrn, authorOrg, date, narrative, srRef }) {
  const div = `<div xmlns="http://www.w3.org/1999/xhtml">${escXhtml(narrative)}</div>`
  return {
    resourceType: 'Composition',
    meta: { profile: [PROFILE_COMP] },
    contained: [{ ...authorOrg, id: 'org-author' }],
    status: 'final',
    type: { coding: [COMP_TYPE], text: COMP_TYPE.display },
    subject: { reference: patientUrn },
    date,
    author: [{ reference: '#org-author' }],
    title: 'Contrarreferencia',
    // NOTA: el enlace al ServiceRequest NO va dentro del documento (rompe la autocontención del
    // Bundle documento). Vive en DocumentReference.context.related (nivel MHD, consultable).
    section: [{
      title: SECTION_TITLE,
      code: { coding: [SECTION_CODE] },
      text: { status: 'generated', div }
    }]
  }
}

// Ensambla la transacción MHD (LACBundleTransactionMHDIT) con el documento embebido.
function buildMhdTransaction({ patient, narrative, date, srRef }) {
  const u = () => `urn:uuid:${randomUUID()}`
  // fullUrls ABSOLUTAS (urn:uuid) — requisito del bundle documento.
  const patientUrn = u(), compUrn = u(), docBundleUrl = u(), docRefUrl = u(), listUrl = u()

  const authorOrg   = buildAuthorOrg()
  const lacPatient  = sanitizePatientForLac(patient)
  const composition = buildComposition({ patientUrn, authorOrg, date, narrative, srRef })

  // Document Bundle (LACBundleDocIT) — CERRADO: solo Composition (autor contenido) + Patient.
  const docBundle = {
    resourceType: 'Bundle', meta: { profile: [PROFILE_DOCBNDL] }, type: 'document',
    identifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl }, timestamp: date,
    entry: [
      { fullUrl: compUrn,    resource: composition },
      { fullUrl: patientUrn, resource: lacPatient }
    ]
  }

  // DocumentReference (LACDocReferenceIT) — requiere author (1..*): Organización contenida.
  // context.related enlaza (a nivel MHD, consultable) la respuesta con el ServiceRequest de origen.
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [PROFILE_DOCREF] },
    contained: [{ ...authorOrg, id: 'org-author' }],
    masterIdentifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current',
    type: { coding: [DOCREF_TYPE] },
    subject: { reference: `Patient/${patient.id}` },
    date,
    author: [{ reference: '#org-author' }],
    ...(srRef ? { context: { related: [{ reference: srRef }] } } : {}),
    content: [{ attachment: { contentType: 'application/fhir+json', url: docBundleUrl } }]
  }

  // List / SubmissionSet (LACList): meta.profile + code fijo 'submissionset' + extensión sourceId (1..1).
  const list = {
    resourceType: 'List', meta: { profile: [PROFILE_LIST] },
    extension: [{ url: SOURCE_ID_EXT, valueIdentifier: { value: CR_SOURCE_ID } }],
    status: 'current', mode: 'working',
    code: { coding: [{ system: MHD_LIST_CODE_SYSTEM, code: 'submissionset' }] },
    date,
    entry: [{ item: { reference: docRefUrl } }]
  }

  return {
    resourceType: 'Bundle', meta: { profile: [PROFILE_TXBNDL] }, type: 'transaction',
    entry: [
      { fullUrl: listUrl,      resource: list,      request: { method: 'POST', url: 'List' } },
      { fullUrl: docRefUrl,    resource: docRef,    request: { method: 'POST', url: 'DocumentReference' } },
      { fullUrl: docBundleUrl, resource: docBundle, request: { method: 'POST', url: 'Bundle' } }
    ]
  }
}

async function submitMhd(txBundle, orch) {
  const url = MHD_ENDPOINT // POST de la transacción
  logStep('POST (MHD)', url)
  const r = await axios.post(url, txBundle, {
    headers: { 'Content-Type': 'application/fhir+json' },
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (orch) orch.push(mkOrch('MHD ITI-65 (POST transaction)', 'POST', url, txBundle, r))
  if (r.status >= 400) { logStep('❌ MHD POST falló:', r.status, JSON.stringify(r.data).slice(0, 800)); throw new Error(`MHD POST ${r.status}`) }
  logStep('✅ MHD OK', r.status)
  return r.status
}

// ============================================================================
// Endpoints
// ============================================================================
app.get(['/forwardercontrarreferencia/_health', '/forwarderContrarreferencia/_health'], (_req, res) => res.send('OK'))

app.post(['/forwardercontrarreferencia/_event', '/forwarderContrarreferencia/_event'], async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  const orch = [] // orquestaciones para el log de OpenHIM
  try {
    // 1) Encounter
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (enc.resourceType !== 'Encounter') throw new Error('Invalid Encounter resource')
    const patientRef = enc.subject?.reference
    const pid = patientRef?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')

    // 2) Observaciones del Encounter
    const obsBundle = await getFromProxy(`/Observation?encounter=Encounter/${encodeURIComponent(uuid)}&_count=200&_format=application/fhir+json`)
    const observations = (obsBundle.entry || []).map(e => e.resource).filter(r => r?.resourceType === 'Observation')
    const effective = pickEffective(observations, enc)

    // 3) Narrativa: obs de texto "Resultado de la Evaluación" (llave de disparo)
    const narrative = obsValueString(firstByConcept(observations, CONCEPT.EVAL))
    if (!narrative) {
      logStep('ⓘ El Encounter no tiene obs de Contrarreferencia', uuid)
      return res.json({ status: 'skip', uuid, reason: 'no contrarreferencia obs' })
    }

    // 4) Patient
    const patient = await getFromProxy(`/Patient/${pid}`)
    normalizePatientIdentifiers(patient)
    await putPatientToNational(patient, orch)

    // 5) Enlace de vuelta: ServiceRequest activo del paciente en el NN (best-effort)
    const srHit = await resolveServiceRequest(patient)
    const srRef = srHit?.reference

    // 6) Documento MHD "Contrarreferencia" (ITI-65) → nodo nacional
    if (!MHD_ENDPOINT) throw new Error('CR_MHD_ENDPOINT no configurado')
    const tx = buildMhdTransaction({ patient, narrative, date: effective || new Date().toISOString(), srRef })
    dumpBundle('contrarreferencia', uuid, tx) // copia en carpeta (evidencia)
    await submitMhd(tx, orch)

    logStep('🎉 Done Contrarreferencia', uuid, '| SR:', srRef || '—')
    sendOpenhim(res, { status: 'ok', uuid, mhd: true, serviceRequest: srRef || null }, orch, req.headers.origin)
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Respuesta DIRECTA desde el dashboard (sin formulario de obs). Recibe la narrativa + el SR a
// contestar y el paciente; arma el MHD (mismo builder) y lo POSTea al nodo nacional (ITI-65).
// Body: { patientUuid?, identifier?, narrative, srRef? }
app.post(['/forwardercontrarreferencia/_answer', '/forwarderContrarreferencia/_answer'], async (req, res) => {
  logStep('📩 POST /_answer', { ...req.body, narrative: req.body?.narrative ? '(texto)' : undefined })
  const { patientUuid, identifier, narrative, srRef } = req.body || {}
  if (!narrative || !String(narrative).trim()) return res.status(400).json({ error: 'Missing narrative' })

  const orch = []
  try {
    // 1) Patient: por uuid desde el proxy OpenMRS; si no, uno mínimo con el identifier.
    let patient
    if (patientUuid) {
      try { patient = await getFromProxy(`/Patient/${patientUuid}`) } catch (e) { logStep('⚠️ Patient del proxy no disponible:', e.message) }
    }
    if (!patient || patient.resourceType !== 'Patient') {
      patient = { resourceType: 'Patient', id: patientUuid || randomUUID(), ...(identifier ? { identifier: [{ value: identifier }] } : {}) }
    }
    normalizePatientIdentifiers(patient)
    await putPatientToNational(patient, orch)

    // 2) SR a contestar: el que envía el dashboard (fila clickeada); si no viene, auto-resolver.
    let resolvedSrRef = srRef
    if (!resolvedSrRef) { const hit = await resolveServiceRequest(patient); resolvedSrRef = hit?.reference }

    // 3) Documento MHD (ITI-65) → nodo nacional
    if (!MHD_ENDPOINT) throw new Error('CR_MHD_ENDPOINT no configurado')
    const tx = buildMhdTransaction({ patient, narrative: String(narrative).trim(), date: new Date().toISOString(), srRef: resolvedSrRef })
    dumpBundle('contrarreferencia', patient.id, tx)
    await submitMhd(tx, orch)

    logStep('🎉 Done Contrarreferencia (_answer) | SR:', resolvedSrRef || '—')
    sendOpenhim(res, { status: 'ok', patient: patient.id, serviceRequest: resolvedSrRef || null, mhd: true }, orch, req.headers.origin)
  } catch (e) {
    logStep('❌ ERROR (_answer):', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_CONTRARREFERENCIA_PORT || 8020
app.listen(PORT, () => logStep(`FHIR Forwarder Contrarreferencia on port ${PORT}`))
