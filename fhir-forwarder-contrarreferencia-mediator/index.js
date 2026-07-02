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
  console.log('✅ Forwarder Contrarreferencia registered')
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
const COMP_TYPE     = { system: 'http://loinc.org', code: '11488-4', display: 'Consultation note' }
const SECTION_CODE  = { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' }
const SECTION_TITLE = 'Resultado de la Evaluación'
const MASTER_ID_SYSTEM   = process.env.CR_MASTER_ID_SYSTEM   || 'urn:ietf:rfc:3986'
// Organización DESTINO (autor de la contrarreferencia = el especialista que responde). En dev = CL.
const AUTHOR_ORG_NAME    = process.env.CR_AUTHOR_ORG_NAME    || 'Hospital Clínico San Borja Arriarán'
const AUTHOR_ORG_COUNTRY = process.env.CR_AUTHOR_ORG_COUNTRY || 'CL'

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

function buildComposition({ patientUrl, authorUrl, date, narrative, srRef }) {
  const div = `<div xmlns="http://www.w3.org/1999/xhtml">${narrative}</div>`
  return {
    resourceType: 'Composition',
    meta: { profile: [PROFILE_COMP] },
    status: 'final',
    type: { coding: [COMP_TYPE], text: COMP_TYPE.display },
    subject: { reference: patientUrl },
    date,
    author: [{ reference: authorUrl }],
    title: 'Contrarreferencia',
    // event.detail enlaza (semánticamente) la nota con la orden/interconsulta que responde.
    ...(srRef ? { event: [{ detail: [{ reference: srRef }] }] } : {}),
    section: [{
      title: SECTION_TITLE,
      code: { coding: [SECTION_CODE] },
      text: { status: 'generated', div },
      ...(srRef ? { entry: [{ reference: srRef }] } : {})
    }]
  }
}

// Ensambla la transacción MHD (LACBundleTransactionMHDIT) con el documento embebido.
function buildMhdTransaction({ patient, narrative, date, srRef }) {
  const u = () => `urn:uuid:${randomUUID()}`
  // Patient con fullUrl = Patient/{id} para consistencia de referencias dentro del documento.
  const patientUrl = `Patient/${patient.id}`
  const authorUrl = u(), compUrl = u(), docBundleUrl = u(), docRefUrl = u(), listUrl = u()

  const authorOrg   = buildAuthorOrg()
  const composition = buildComposition({ patientUrl, authorUrl, date, narrative, srRef })

  // Document Bundle (LACBundleDocIT) — autocontenido
  const docBundle = {
    resourceType: 'Bundle', meta: { profile: [PROFILE_DOCBNDL] }, type: 'document',
    identifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl }, timestamp: date,
    entry: [
      { fullUrl: compUrl,    resource: composition },
      { fullUrl: authorUrl,  resource: authorOrg },
      { fullUrl: patientUrl, resource: patient }
    ]
  }

  // DocumentReference (LACDocReferenceIT) — type 11488-4 para que el origen lo consulte por type.
  // context.related enlaza (a nivel MHD, consultable) la respuesta con el ServiceRequest de origen.
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [PROFILE_DOCREF] },
    masterIdentifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current',
    type: { coding: [COMP_TYPE] },
    subject: { reference: `Patient/${patient.id}` },
    date,
    ...(srRef ? { context: { related: [{ reference: srRef }] } } : {}),
    content: [{ attachment: { contentType: 'application/fhir+json', url: docBundleUrl } }]
  }

  // List / SubmissionSet (LACList)
  const list = {
    resourceType: 'List', status: 'current', mode: 'working', date,
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
    sendOpenhim(res, { status: 'ok', uuid, mhd: true, serviceRequest: srRef || null }, orch)
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_CONTRARREFERENCIA_PORT || 8020
app.listen(PORT, () => logStep(`FHIR Forwarder Contrarreferencia on port ${PORT}`))
