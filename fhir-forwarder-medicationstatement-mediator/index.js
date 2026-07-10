// index.js (FHIR Event Forwarder Mediator) — Reporte Medicamentos (obs) -> MedicationStatement FHIR
// Toma el Encounter del formulario "Reporte Medicamentos", mapea sus observaciones a uno o más
// MedicationStatement (perfil LACMedicationStatementMeOw del IG RACSEL) y los reenvía al nodo nacional.
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
function sendOpenhim(res, summary, orchestrations) {
  res.set('Content-Type', 'application/json+openhim')
  res.send(JSON.stringify({
    'x-mediator-urn': mediatorConfig.urn,
    status: 'Successful',
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary), timestamp: new Date().toISOString() },
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

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) { console.error('❌ Registration error:', err); process.exit(1) }
  console.log('✅ Forwarder MedicationStatement registered')
  Promise.all(
    (mediatorConfig.defaultChannelConfig || []).map(ch =>
      axios.post(
        `${openhimConfig.apiURL}/channels`,
        { ...ch, mediator_urn: mediatorConfig.urn },
        { auth: { username: openhimConfig.username, password: openhimConfig.password } }
      )
      .then(() => console.log(`✅ Channel created: ${ch.name}`))
      .catch(e => {
        const msg = e?.response?.data || e?.message || e.toString()
        if (String(msg).includes('duplicate key error')) console.log(`ℹ️ Channel already exists: ${ch.name}`)
        else console.error(`❌ Channel ${ch.name} error:`, msg)
      })
    )
  ).then(() => { console.log('✅ All channels processed'); activateHeartbeat(openhimConfig) })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// ============================================================================
// Configuración de mapeo (UUIDs del formulario "Reporte Medicamentos")
// ============================================================================
const CONCEPT = {
  GROUP:      process.env.MS_CONCEPT_GROUP      || 'ed736658-0ae5-4a0b-9da3-a5eeadf6dca6',   // obsGroup Set "reporte medicamento" (hasMember)
  MEDICATION: process.env.MS_CONCEPT_MEDICATION || '1282AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Coded -> medicationCodeableConcept
  DOSE_TEXT:  process.env.MS_CONCEPT_DOSE_TEXT  || '165503AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Text  -> dosage.text
  ROUTE_TEXT: process.env.MS_CONCEPT_ROUTE_TEXT || '165502AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'  // Text  -> dosage.route.text
}
// status (1..1). MedicationStatement: active|completed|entered-in-error|intended|stopped|on-hold|unknown|not-taken
const MS_STATUS  = process.env.MS_STATUS || 'active'
const PROFILE_MS = process.env.MS_PROFILE_URL || 'http://racsel.org/StructureDefinition/LACMedicationStatementMeOw'
const SNOMED_SYSTEM = 'http://snomed.info/sct'

// ── Documento MHD "Reporte Medicamentos" (Fase 2, IG RACSEL) ──
// Si MS_MHD_ENABLED=true, además de subir el/los MedicationStatement, ensambla el documento
// (Composition + Document Bundle + DocumentReference + List) y lo POSTea como transacción MHD (ITI-65).
const MHD_ENABLED  = (process.env.MS_MHD_ENABLED || 'true').toLowerCase() === 'true'
// Dos servidores FHIR DISTINTOS:
//   - Recurso clínico (Paso 1) -> MS_FHIR_RESOURCE_URL (default FHIR_NODE_URL) = hapilocal
//   - Documento MHD  (Paso 2)  -> MS_MHD_ENDPOINT                              = hapinacional
// Sin fallback cruzado: si MS_MHD_ENDPOINT no está, se omite el documento.
const MHD_ENDPOINT = (process.env.MS_MHD_ENDPOINT || '').replace(/\/$/, '')
const PROFILE_COMP    = process.env.MS_COMPOSITION_PROFILE || 'http://racsel.org/StructureDefinition/LACCompositionMeOw'
const PROFILE_DOCBNDL = process.env.MS_DOCBUNDLE_PROFILE   || 'http://racsel.org/StructureDefinition/LACBundleDocMeOw'
const PROFILE_DOCREF  = process.env.MS_DOCREF_PROFILE      || 'http://racsel.org/StructureDefinition/LACDocReferenceMeOw'
const PROFILE_TXBNDL  = process.env.MS_TXBUNDLE_PROFILE    || 'http://racsel.org/StructureDefinition/LACBundleTransactionMHDMeOw'
const PROFILE_ORG_LAC = process.env.MS_ORG_PROFILE_URL     || 'http://racsel.org/StructureDefinition/LACOrganization'
const PROFILE_LIST_LAC = process.env.MS_LIST_PROFILE_URL   || 'http://racsel.org/StructureDefinition/LACList'
// Displays LOINC canónicos exigidos por el TS/perfil RACSEL:
//   56445-0 => 'Medication summary Document' (Composition.type y DocumentReference.type)
//   55112-7 => 'Document summary'            (discriminador del slice Composition.section:Medicamentos)
const COMP_TYPE     = { system: 'http://loinc.org', code: '56445-0', display: 'Medication summary Document' }
const SECTION_CODE  = { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' }
// sourceId del SubmissionSet (MHD): OID del nodo con urn:oid: (mhd-startswithoid)
const MHD_SOURCE_ID = process.env.MS_MHD_SOURCE_ID || process.env.MHD_SOURCE_ID || 'urn:oid:2.16.152'
const MASTER_ID_SYSTEM   = process.env.MS_MASTER_ID_SYSTEM   || 'urn:ietf:rfc:3986'
const AUTHOR_ORG_NAME    = process.env.MS_AUTHOR_ORG_NAME    || 'Hospital Clínico San Borja Arriarán'
const AUTHOR_ORG_COUNTRY = process.env.MS_AUTHOR_ORG_COUNTRY || 'CL'

// ── Terminología (TS): $lookup de displays SNOMED ──
// Hace $lookup y REEMPLAZA el display con el canónico del TS. Activado por defecto (MS_TS_APPLY_DISPLAY=true):
// mientras el TS no tenga SNOMED el lookup no devuelve display → no cambia nada; cuando lo tenga, normaliza
// solo, sin tocar config. Para apagarlo: MS_TS_APPLY_DISPLAY=false (o MS_TS_LOOKUP_ENABLED=false).
const TS_BASE = (process.env.MS_TERMINOLOGY_BASE || process.env.TERMINOLOGY_BASE || process.env.TERMINOLOGY_BASE_URL || '').replace(/\/$/, '')
const TS_LOOKUP_ENABLED = String(process.env.MS_TS_LOOKUP_ENABLED || process.env.FEATURE_TS_LOOKUP_ENABLED || 'true').toLowerCase() === 'true'
const TS_APPLY_DISPLAY  = String(process.env.MS_TS_APPLY_DISPLAY || 'true').toLowerCase() === 'true' // ON por defecto
const TS_DISPLAY_LANGUAGE = process.env.TS_DISPLAY_LANGUAGE || 'en'
const TS_SNOMED_VERSION = process.env.SNOMED_VERSION_URI || process.env.TS_SNOMED_VERSION || ''
const TS_TIMEOUT_MS = parseInt(process.env.MS_TS_TIMEOUT_MS || process.env.TS_TIMEOUT_MS || '8000', 10)

// ============================================================================
// Fuentes (proxy FHIR de OpenMRS) y destino (nodo nacional)
// ============================================================================
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
// Nodo de recursos clínicos (Paso 1) — distinto del MHD (Paso 2)
const RESOURCE_BASE = (process.env.MS_FHIR_RESOURCE_URL || process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
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

async function putToNode(resource, orch) {
  const url = `${RESOURCE_BASE}/fhir/${resource.resourceType}/${resource.id}`
  logStep('PUT (node)', url)
  const r = await axios.put(url, resource, {
    headers: { 'Content-Type': 'application/fhir+json' },
    validateStatus: false,
    httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (orch) orch.push(mkOrch(`PUT ${resource.resourceType}/${resource.id}`, 'PUT', url, resource, r))
  if (r.status >= 400) {
    logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
    throw new Error(`PUT failed ${r.status}`)
  }
  logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
  return r.status
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
    delete id.extension
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

// medicationCodeableConcept: desde el valueCodeableConcept del obs Medicamento.
// El binding del perfil es SNOMED → conservamos coding SNOMED + text.
function buildMedicationCC(medObs) {
  const cc = medObs?.valueCodeableConcept
  if (!cc) return undefined
  const coding = (cc.coding || []).filter(c => c.system === SNOMED_SYSTEM)
  const text = cc.text || cc.coding?.[0]?.display
  const out = {}
  if (coding.length) out.coding = coding
  if (text) out.text = text
  return Object.keys(out).length ? out : undefined
}

// $lookup de un código SNOMED en el TS. Devuelve el display canónico (idioma TS_DISPLAY_LANGUAGE) o null.
async function tsLookupDisplay(system, code) {
  if (!TS_BASE || !system || !code) return null
  const params = { system, code, displayLanguage: TS_DISPLAY_LANGUAGE }
  if (TS_SNOMED_VERSION) params.version = TS_SNOMED_VERSION
  const r = await axios.get(`${TS_BASE}/CodeSystem/$lookup`, {
    params, headers: { Accept: 'application/fhir+json' },
    timeout: TS_TIMEOUT_MS, validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (r.status >= 400 || r.data?.resourceType !== 'Parameters') return null
  const p = (r.data.parameter || []).find(x => x.name === 'display')
  return (p && typeof p.valueString === 'string' && p.valueString.trim()) ? p.valueString.trim() : null
}

// Recorre los MedicationStatement y hace $lookup de cada coding SNOMED (en PARALELO, para acotar la
// latencia si el TS no responde). Por defecto SOLO loguea el display sugerido; solo REEMPLAZA el display
// si MS_TS_APPLY_DISPLAY=true. Nunca bloquea el flujo: cualquier error de TS se ignora.
async function normalizeMedicationDisplays(msResources) {
  if (!TS_LOOKUP_ENABLED || !TS_BASE) return
  const codings = []
  for (const ms of msResources)
    for (const c of (ms.medicationCodeableConcept?.coding || []))
      if (c.system === SNOMED_SYSTEM && c.code) codings.push(c)
  if (!codings.length) return
  const uniq = [...new Set(codings.map(c => c.code))]
  const pairs = await Promise.all(uniq.map(async code => {
    try { return [code, await tsLookupDisplay(SNOMED_SYSTEM, code)] }
    catch (e) { logStep('⚠️ TS lookup error (ignorado)', `${code}:`, e.message); return [code, null] }
  }))
  const map = new Map(pairs)
  for (const c of codings) {
    const disp = map.get(c.code)
    if (!disp || disp === c.display) continue
    if (TS_APPLY_DISPLAY) { logStep('✏️ TS display reemplazado', `${c.code}: "${c.display}" -> "${disp}"`); c.display = disp }
    else logStep('🔎 TS display sugerido (no aplicado)', `${c.code}: "${c.display}" -> "${disp}"`)
  }
}

// ============================================================================
// Construcción del MedicationStatement (perfil LACMedicationStatementMeOw)
// ============================================================================
function buildMedicationStatement({ id, patientRef, encId, effective, medObs, doseText, routeText }) {
  const medication = buildMedicationCC(medObs)
  const dosageEntry = {}
  if (doseText) dosageEntry.text = doseText
  if (routeText) dosageEntry.route = { text: routeText }
  const dosage = Object.keys(dosageEntry).length ? [dosageEntry] : undefined

  return {
    resourceType: 'MedicationStatement',
    id,
    meta: { profile: [PROFILE_MS] },
    status: MS_STATUS,
    ...(medication ? { medicationCodeableConcept: medication } : {}),
    subject: { reference: patientRef },
    ...(encId ? { context: { reference: `Encounter/${encId}` } } : {}),
    ...(effective ? { effectiveDateTime: effective } : {}),
    ...(dosage ? { dosage } : {})
  }
}

// ============================================================================
// Documento MHD (Fase 2): Composition + Document Bundle + DocumentReference + List → transacción
// ============================================================================
function buildAuthorOrg(id) {
  return { resourceType: 'Organization', ...(id ? { id } : {}), meta: { profile: [PROFILE_ORG_LAC] }, name: AUTHOR_ORG_NAME, address: [{ country: AUTHOR_ORG_COUNTRY }] }
}

function buildComposition({ patientUrl, authorUrl, msUrls, date, narrative }) {
  return {
    resourceType: 'Composition',
    meta: { profile: [PROFILE_COMP] },
    status: 'final',
    type: { coding: [COMP_TYPE], text: COMP_TYPE.display },
    subject: { reference: patientUrl },
    date,
    author: [{ reference: authorUrl }],
    title: 'Reporte de Medicamentos',
    section: [{
      title: 'Medicamentos',
      code: { coding: [SECTION_CODE] },
      text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${narrative}</div>` },
      entry: msUrls.map(u => ({ reference: u }))
    }]
  }
}

// Ensambla la transacción MHD (LACBundleTransactionMHDMeOw) con el documento embebido.
function buildMhdTransaction({ patient, msResources, date }) {
  const u = () => `urn:uuid:${randomUUID()}`
  // Patient con fullUrl ABSOLUTO (urn:uuid) dentro del documento; todas las referencias internas
  // (Composition/MedicationStatement.subject) apuntan a este mismo urn:uuid → sin huérfanos.
  const patientUrl = `urn:uuid:${patient.id}`
  // Referencia literal al paciente en el servidor (List/DocumentReference a nivel transacción)
  const patientRef = `Patient/${patient.id}`
  const authorUrl = u(), compUrl = u(), docBundleUrl = u(), docRefUrl = u(), listUrl = u()
  const ssId = randomUUID()

  // Clonar los MedicationStatement para el documento y reapuntar su subject al Patient del bundle
  // (sin mutar los recursos ya subidos al nodo de recursos, cuyo subject es la referencia literal).
  const msEntries = msResources.map(ms => ({
    url: u(),
    res: { ...JSON.parse(JSON.stringify(ms)), subject: { reference: patientUrl } }
  }))

  const authorOrg   = buildAuthorOrg()
  const narrative   = 'Reporte de medicamentos: ' + (msResources.map(m => m.medicationCodeableConcept?.text).filter(Boolean).join('; ') || 's/d')
  const composition = buildComposition({ patientUrl, authorUrl, msUrls: msEntries.map(e => e.url), date, narrative })

  // Document Bundle (LACBundleDocMeOw) — autocontenido, referencias urn:uuid
  const docBundle = {
    resourceType: 'Bundle', meta: { profile: [PROFILE_DOCBNDL] }, type: 'document',
    identifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl }, timestamp: date,
    entry: [
      { fullUrl: compUrl,    resource: composition },
      { fullUrl: authorUrl,  resource: authorOrg },
      { fullUrl: patientUrl, resource: patient },
      ...msEntries.map(e => ({ fullUrl: e.url, resource: e.res }))
    ]
  }

  // DocumentReference (LACDocReferenceMeOw) — author (1..1) obligatorio: Organization contenida
  const docRefOrg = buildAuthorOrg('author-org')
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [PROFILE_DOCREF] },
    contained: [docRefOrg],
    masterIdentifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current',
    type: { coding: [COMP_TYPE] },
    author: [{ reference: '#author-org' }],
    subject: { reference: patientRef },
    date,
    content: [{ attachment: { contentType: 'application/fhir+json', url: docBundleUrl } }]
  }

  // List / SubmissionSet (LACList) — requiere meta.profile, identifier(official), code y subject
  // para *conformar* al perfil y matchear el slice SubmissionSet de la transacción.
  const list = {
    resourceType: 'List',
    meta: { profile: [PROFILE_LIST_LAC] },
    text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">SubmissionSet Reporte de Medicamentos</div>' },
    extension: [{ url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId', valueIdentifier: { value: MHD_SOURCE_ID } }],
    identifier: [{ use: 'official', system: 'urn:ietf:rfc:3986', value: `urn:uuid:${ssId}` }],
    status: 'current', mode: 'working',
    code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
    subject: { reference: patientRef },
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
app.get(['/forwardermedicationstatement/_health', '/forwarderMedicationStatement/_health'], (_req, res) => res.send('OK'))

// ── PDQm: verificación de identidad contra el maestro (ITI-78). OPERACIONAL: consulta el maestro y,
// si hay match REAL, fusiona (aditivo) los identifiers del maestro en el paciente. Si NO encuentra o
// cae en el fallback sintético (tag urn:pdqm:fallback), NO toca nada → mantiene los ids propios.
// Nunca bloquea el envío. Endpoint: PDQM_LOOKUP_URL (OpenHIM /pdqm/_lookup).
const PDQM_LOOKUP_URL = (process.env.PDQM_LOOKUP_URL || 'https://10.68.174.206:5000/pdqm/_lookup').replace(/\/+$/, '')
const PDQM_VERIFY_ENABLED = String(process.env.PDQM_VERIFY_ENABLED || 'true').toLowerCase() === 'true'
const PDQM_ENRICH_IDS = String(process.env.PDQM_ENRICH_IDS || 'true').toLowerCase() === 'true'
const PDQM_TIMEOUT_MS = parseInt(process.env.PDQM_TIMEOUT_MS || '6000', 10)
// Fusiona identifiers del maestro que no estén ya presentes (por system|value), SIN quitar los propios.
function mergeMasterIdentifiers(patient, masterPatient) {
  const own = patient.identifier || (patient.identifier = [])
  const key = i => `${String(i.system || '').toLowerCase()}|${i.value}`
  const seen = new Set(own.map(key))
  let added = 0
  for (const mi of (masterPatient.identifier || [])) {
    if (!mi || !mi.value || seen.has(key(mi))) continue
    own.push(mi); seen.add(key(mi)); added++
  }
  return added
}
async function verifyPatientAgainstMaster(patient, orch) {
  if (!PDQM_VERIFY_ENABLED || !PDQM_LOOKUP_URL) return { skipped: true }
  const ids = [...new Set((patient?.identifier || []).map(i => i && i.value).filter(Boolean))]
  for (const identifier of ids) {
    try {
      const r = await axios.post(PDQM_LOOKUP_URL, { identifier }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: PDQM_TIMEOUT_MS, validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
      })
      if (orch) orch.push(mkOrch(`PDQm _lookup (${identifier})`, 'POST', PDQM_LOOKUP_URL, { identifier }, r))
      const b = r.data || {}
      const match = (b.entry || []).map(e => e && e.resource).find(x => x && x.resourceType === 'Patient')
      const synthetic = (((b.meta || {}).tag) || []).some(t => t && t.system === 'urn:pdqm:fallback')
        || ((((match || {}).meta || {}).tag) || []).some(t => t && t.system === 'urn:pdqm:fallback')
      if (match && !synthetic) {
        const added = PDQM_ENRICH_IDS ? mergeMasterIdentifiers(patient, match) : 0
        logStep('✅ PDQm: verificado en el maestro', identifier, '->', `Patient/${match.id || '?'} (+${added} id maestro)`)
        return { matched: true, masterPatient: match, identifier, added }
      }
      logStep('ⓘ PDQm: sin match real (fallback sintético) — se mantienen los ids propios', identifier)
    } catch (e) { logStep('⚠️ PDQm lookup error (ignorado) — se mantienen los ids propios', `${identifier}:`, e.message) }
  }
  logStep('ⓘ PDQm: paciente NO encontrado en el maestro — se mantienen los ids propios')
  return { matched: false }
}

app.post(['/forwardermedicationstatement/_event', '/forwarderMedicationStatement/_event'], async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  let sent = 0
  const orch = [] // orquestaciones para el log de OpenHIM
  try {
    // 1) Encounter
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (enc.resourceType !== 'Encounter') throw new Error('Invalid Encounter resource')
    const patientRef = enc.subject?.reference
    const pid = patientRef?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')

    // 2) Observaciones del Encounter (incluye miembros del obs grupo)
    const obsBundle = await getFromProxy(`/Observation?encounter=Encounter/${encodeURIComponent(uuid)}&_include=Observation:has-member&_count=200&_format=application/fhir+json`)
    const observations = (obsBundle.entry || []).map(e => e.resource).filter(r => r?.resourceType === 'Observation')
    const byId = {}; for (const o of observations) if (o.id) byId[o.id] = o
    const effective = pickEffective(observations, enc)
    const membersOf = g => (g.hasMember || []).map(m => byId[m.reference?.split('/').pop()]).filter(Boolean)

    // Unidades de medicamento: preferir el obs grupo "reporte medicamento" (hasMember) → pareo correcto;
    // si no hay grupos, fallback plano (un medicamento con la primera Dosis/Vía del encuentro).
    let units = []
    const groups = observations.filter(o => obsHasConcept(o, CONCEPT.GROUP))
    if (groups.length) {
      units = groups.map(g => {
        const m = membersOf(g)
        return {
          id: g.id,
          medObs:    m.find(x => obsHasConcept(x, CONCEPT.MEDICATION)),
          doseText:  obsValueString(m.find(x => obsHasConcept(x, CONCEPT.DOSE_TEXT))),
          routeText: obsValueString(m.find(x => obsHasConcept(x, CONCEPT.ROUTE_TEXT)))
        }
      }).filter(u => u.medObs)
    } else {
      const doseText  = obsValueString(firstByConcept(observations, CONCEPT.DOSE_TEXT))
      const routeText = obsValueString(firstByConcept(observations, CONCEPT.ROUTE_TEXT))
      units = observations.filter(o => obsHasConcept(o, CONCEPT.MEDICATION))
        .map(medObs => ({ id: medObs.id, medObs, doseText, routeText }))
    }
    if (!units.length) {
      logStep('ⓘ El Encounter no tiene observaciones de Reporte Medicamentos', uuid)
      return res.json({ status: 'skip', uuid, reason: 'no medication obs' })
    }

    // 3) Patient (subir referencia)
    const patient = await getFromProxy(`/Patient/${pid}`)
    normalizePatientIdentifiers(patient)
    await verifyPatientAgainstMaster(patient, orch) // PDQm (soft, log-only): verifica identidad, no cambia el envío
    await putToNode(patient, orch); sent++

    // 4) Un MedicationStatement por unidad/grupo (cada uno con su Dosis/Vía pareadas)
    const created = []
    const msResources = []
    for (const u of units) {
      const ms = buildMedicationStatement({
        id: u.id, patientRef, encId: uuid, effective, medObs: u.medObs, doseText: u.doseText, routeText: u.routeText
      })
      if (!ms.medicationCodeableConcept) { logStep('⚠️ Medicamento sin código, se omite', u.id); continue }
      msResources.push(ms)
    }

    // 5) Terminología: $lookup de displays SNOMED contra el TS (una pasada, en paralelo). Por defecto
    //    solo consulta/loguea; reemplaza el display solo si MS_TS_APPLY_DISPLAY=true. Antes de subir,
    //    para que tanto el recurso del nodo como el documento MHD queden consistentes.
    await normalizeMedicationDisplays(msResources)

    for (const ms of msResources) { await putToNode(ms, orch); sent++; created.push(ms.id) }

    // 6) Documento MHD "Reporte Medicamentos" (Fase 2) — va a un servidor FHIR distinto (MHD)
    let mhd = false
    if (MHD_ENABLED && msResources.length) {
      if (!MHD_ENDPOINT) {
        logStep('⚠️ MHD habilitado pero sin endpoint (MS_MHD_ENDPOINT) — se omite el documento')
      } else {
        const tx = buildMhdTransaction({ patient, msResources, date: effective || new Date().toISOString() })
        dumpBundle('medicationstatement', uuid, tx) // copia en carpeta (evidencia)
        try { await submitMhd(tx, orch); mhd = true }
        catch (e) { logStep('⚠️ No se pudo enviar el documento MHD:', e.message) }
      }
    }

    logStep('🎉 Done MedicationStatement', uuid, '| creados:', created.length, '| MHD:', mhd)
    sendOpenhim(res, { status: 'ok', uuid, sent, medicationStatements: created, mhd }, orch)
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_MEDICATIONSTATEMENT_PORT || 8017
app.listen(PORT, () => logStep(`FHIR Forwarder MedicationStatement on port ${PORT}`))
