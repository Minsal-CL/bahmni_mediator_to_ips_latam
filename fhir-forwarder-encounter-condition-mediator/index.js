// index.js — OpenHIM Mediator: OpenMRS Diagnostic Observations → FHIR Condition (category: encounter-diagnosis)
//
// Diseño:
// - Recibe POST /forwardercondition/_event { uuid }
//   - uuid puede ser Encounter.id, Composition.id (que referencia Encounter) o Bundle.id persistido con un Encounter dentro.
// - Resuelve Encounter y Patient asociados (reutiliza lógica robusta de resolución).
// - Consulta Observations del Encounter en OpenMRS FHIR.
// - Convierte cada Observation diagnóstica a Condition con:
//     * category: encounter-diagnosis (http://terminology.hl7.org/CodeSystem/condition-category)
//     * clinicalStatus: active (http://terminology.hl7.org/CodeSystem/condition-clinical)
//     * verificationStatus: confirmed (http://terminology.hl7.org/CodeSystem/condition-ver-status)
//     * code: **solo** codings con system === 'http://snomed.info/sct' (se descartan codificaciones OpenMRS u otras)
//     * subject, encounter, onset/recordedDate, asserter si disponible
// - Publica/actualiza (PUT) cada Condition en el nodo FHIR de destino (HAPI u otro) para trazabilidad.
//
// Notas:
// - Si una Observation **no** contiene codificación SNOMED, por defecto **se omite** (no se genera Condition) para evitar problemas aguas arriba.
//   Puede activarse una ruta opcional de traducción (ConceptMap $translate) con variables de entorno si se desea, ver FLAGS abajo.
// - Inspirado y compatible con tu forwarder de Inmunizaciones (estructura de registro y utilidades compartidas).

import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import mediatorConfig from './mediatorConfig.json' assert { type: 'json' }

// =============================
// OpenHIM & HTTPS
// =============================
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: (process.env.OPENHIM_API || '').replace(/\/$/, ''),
  trustSelfSigned: true
}

axios.defaults.httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  cert: process.env.CLIENT_CERT && fs.existsSync(process.env.CLIENT_CERT) ? fs.readFileSync(process.env.CLIENT_CERT) : undefined,
  key: process.env.CLIENT_KEY && fs.existsSync(process.env.CLIENT_KEY) ? fs.readFileSync(process.env.CLIENT_KEY) : undefined
})

// =============================
// Flags & Consts
// =============================
function logStep(...args) { console.log(new Date().toISOString(), '-', ...args) }
const DEBUG = /^true$/i.test(process.env.DEBUG_CONDITION || 'false')
function dbg(...a) { if (DEBUG) logStep('[DEBUG_COND]', ...a) }

const FHIR_NODE_BASE = (process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
const FHIR_PROXY_BASE = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')

// FHIR systems/codes
const SNOMED = 'http://snomed.info/sct'
const CC_CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category'
const CC_CLINICAL = 'http://terminology.hl7.org/CodeSystem/condition-clinical'
const CC_VERIFY = 'http://terminology.hl7.org/CodeSystem/condition-ver-status'

// Traducción opcional si falta SNOMED (apagado por defecto)
const USE_TRANSLATE = /^true$/i.test(process.env.USE_TRANSLATE_TO_SNOMED || 'false')
const TERMINOLOGY_BASE = (process.env.TERMINOLOGY_BASE || '').replace(/\/$/, '')
const TRANSLATE_TARGET = SNOMED

// =============================
// SNOMED \u2192 ICD-10 (opcional)
// =============================
const USE_SNOMED_TO_ICD10 = /^true$/i.test(process.env.USE_SNOMED_TO_ICD10 || 'false')
const ICD10_TARGET_SYSTEM = process.env.ICD10_TARGET_SYSTEM || 'http://hl7.org/fhir/sid/icd-10'
const ICD10_MODE = (process.env.ICD10_MODE || 'append').toLowerCase() // 'replace' | 'append'
const ALLOW_ICD10_NON_EQUIVALENT = /^true$/i.test(process.env.ALLOW_ICD10_NON_EQUIVALENT || 'false')
const ALLOW_ICD10_MAP_ADVICE_ALWAYS = /^true$/i.test(process.env.ALLOW_ICD10_MAP_ADVICE_ALWAYS || 'true')

// ====== Códigos Bahmni/OpenMRS para diagnóstico de visita (ajustables por ENV) ======
// Grupo "Visit Diagnoses" (observation set)
const DIAG_SET_CODE = (process.env.DIAG_SET_CODE || 'd367d289-5e07-11ef-8f7c-0242ac120002')
// Miembros dentro del set:
const DIAG_CODED = (process.env.DIAG_CODED || 'd3686b3c-5e07-11ef-8f7c-0242ac120002')            // "Coded Diagnosis"
const DIAG_CERTAINTY = (process.env.DIAG_CERTAINTY || 'd368b61c-5e07-11ef-8f7c-0242ac120002')    // "Diagnosis Certainty"
const DIAG_ORDER = (process.env.DIAG_ORDER || 'd369afd7-5e07-11ef-8f7c-0242ac120002')            // "Diagnosis order"

function isCode(res, code) { return codeList(res).some(c => c.code === code) }
function indexById(bundle) { const m = new Map(); for (const e of (bundle.entry || [])) { const r = e.resource; if (r?.id) m.set(r.id, r) } return m }

// =============================
// HTTP helpers to/from OpenMRS proxy and Node FHIR
// =============================
async function getFromProxy(path) {
  const url = `${FHIR_PROXY_BASE}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    httpsAgent: axios.defaults.httpsAgent
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

async function putToNode(resource) {
  const url = `${FHIR_NODE_BASE}/fhir/${resource.resourceType}/${resource.id}`
  try {
    logStep('PUT (node)', url)
    const resp = await axios.put(url, resource, { validateStatus: false, httpsAgent: axios.defaults.httpsAgent })
    logStep('DEBUG node status:', resp.status)
    if (resp.status >= 400) throw new Error(`Node returned ${resp.status}`)
  } catch (e) {
    logStep('❌ PUT error:', e.message)
    throw e
  }
}

// Normaliza los identifier del Patient a la forma canónica LAC (idempotente: reconoce
// tanto el shape crudo de OpenMRS como el ya normalizado, para que un PUT repetido no lo altere).
function normalizePatientIdentifiers(patient) {
  if (!Array.isArray(patient?.identifier)) return

  /***const getOid = (envVar, defaultVal) => {
    const val = process.env[envVar] || defaultVal
    return val.startsWith('urn:oid.') ? val : (val.startsWith('urn:oid:') ? val.replace(':', '.') : `urn:oid.${val}`)
  }  ***/
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

// =============================
// Generic utils
// =============================
function codeList(res) { return (res?.code?.coding || []).map(c => ({ system: c.system, code: c.code, display: c.display })).filter(x => x.code) }
function pickFirstSNOMED(res) { return codeList(res).find(c => c.system === SNOMED) }
function toDateOnly(dt) { return (typeof dt === 'string' ? dt.substring(0, 10) : undefined) }

async function getIfExists(path) {
  try { return await getFromProxy(path) } catch (e) {
    if (String(e.message).endsWith(' returned 404')) return null
    throw e
  }
}

async function resolveEncounterAndPatient(uuid) {
  // 1) Encounter directo
  const enc1 = await getIfExists(`/Encounter/${encodeURIComponent(uuid)}`)
  if (enc1?.resourceType === 'Encounter') {
    const pid = enc1.subject?.reference?.split('/')[1]
    return { enc: enc1, pid }
  }
  // 2) Composition → Encounter
  const comp = await getIfExists(`/Composition/${encodeURIComponent(uuid)}`)
  if (comp?.resourceType === 'Composition') {
    const encRef = comp.encounter?.reference
    if (encRef?.startsWith('Encounter/')) {
      const encId = encRef.split('/')[1]
      const enc2 = await getIfExists(`/Encounter/${encodeURIComponent(encId)}`)
      if (enc2?.resourceType === 'Encounter') {
        const pid = enc2.subject?.reference?.split('/')[1]
        return { enc: enc2, pid }
      }
    }
  }
  // 3) Bundle persistido que contiene un Encounter
  const bun = await getIfExists(`/Bundle/${encodeURIComponent(uuid)}`)
  if (bun?.resourceType === 'Bundle' && Array.isArray(bun.entry)) {
    const enc3 = bun.entry.map(e => e.resource).find(r => r?.resourceType === 'Encounter')
    if (enc3?.id) {
      const pid = enc3.subject?.reference?.split('/')[1]
      return { enc: enc3, pid }
    }
  }
  return { enc: null, pid: null }
}

// =============================
// Optional: ConceptMap $translate → SNOMED (simple)
// =============================
function parseTranslate(parameters) {
  const params = parameters?.parameter || []
  const matches = params.filter(p => p.name === 'match')
  for (const m of matches) {
    const parts = m.part || []
    const concept = parts.find(p => p.name === 'concept')?.valueCoding
    const code = concept?.code || parts.find(p => p.name === 'code')?.valueCode
    const system = concept?.system || parts.find(p => p.name === 'system')?.valueUri
    const display = concept?.display || parts.find(p => p.name === 'display')?.valueString
    if (code && system === SNOMED) return { system, code, ...(display ? { display } : {}) }
  }
  return null
}

async function translateToSNOMED(sourceCoding) {
  if (!USE_TRANSLATE || !TERMINOLOGY_BASE || !sourceCoding?.code) return null
  try {
    const url = `${TERMINOLOGY_BASE}/ConceptMap/$translate`
    const params = { system: sourceCoding.system, code: sourceCoding.code, targetsystem: SNOMED }
    dbg('[$translate → SNOMED] request', { url, params })
    const { data } = await axios.get(url, {
      params,
      httpsAgent: axios.defaults.httpsAgent
    })
    dbg('[$translate → SNOMED] response',
      typeof data === 'string' ? data.substring(0, 2000) : JSON.stringify(data).substring(0, 2000)
    )
    return parseTranslate(data)
  } catch (e) {
    dbg('translate error:', e.message)
    return null
  }
}

function parseTranslateICD10(parameters) {
  const params = parameters?.parameter || []
  const matches = params.filter(p => p.name === 'match')
  const ordered = [
    ...matches.filter(m => m.part?.some(p => p.name === 'equivalence' && p.valueCode === 'equivalent')),
    ...matches.filter(m => m.part?.some(p => p.name === 'equivalence' && p.valueCode !== 'equivalent'))
  ]
  for (const match of ordered) {
    const parts = match.part || []
    const eq = parts.find(p => p.name === 'equivalence')?.valueCode
    const concept = parts.find(p => p.name === 'concept')?.valueCoding
    const code = concept?.code || parts.find(p => p.name === 'code')?.valueCode
    const system = concept?.system || parts.find(p => p.name === 'system')?.valueUri
    const display = concept?.display || parts.find(p => p.name === 'display')?.valueString
    const eqOk = (eq === 'equivalent') || (ALLOW_ICD10_NON_EQUIVALENT && (!eq || eq === 'wider' || eq === 'narrower' || eq === 'inexact'))
    if (code && system === ICD10_TARGET_SYSTEM && eqOk) {
      return { system, code, ...(display ? { display } : {}) }
    }
  }
  if (ALLOW_ICD10_MAP_ADVICE_ALWAYS) {
    const advice = params.find(p => p.name === 'message')?.valueString || ''
    const matchAlways = advice.match(/ALWAYS\s+([A-Z]\d{2}(?:\.\d{1,2})?)/i)
    if (matchAlways) {
      return { system: ICD10_TARGET_SYSTEM, code: matchAlways[1].toUpperCase() }
    }
  }
  return null
}

async function translateSnomedToICD10(snomedCoding) {
  if (!USE_SNOMED_TO_ICD10 || !TERMINOLOGY_BASE || !snomedCoding?.code) return null
  try {
    const url = `${TERMINOLOGY_BASE}/ConceptMap/$translate`
    const params = {
      system: SNOMED,
      code: snomedCoding.code,
      targetsystem: ICD10_TARGET_SYSTEM
    }
    dbg('[$translate SNOMED→ICD10] request', { url, params })
    const { data } = await axios.get(url, {
      params,
      httpsAgent: axios.defaults.httpsAgent
    })
    dbg('[$translate SNOMED→ICD10] response',
      typeof data === 'string' ? data.substring(0, 2000) : JSON.stringify(data).substring(0, 2000)
    )
    return parseTranslateICD10(data)
  } catch (e) {
    dbg('icd10 translate error:', e.message)
    return null
  }
}

// =============================
// Builder: Condition from Observation
// =============================
// Opcional: $lookup en Snowstorm si quieres siempre Display SNOMED
const USE_LOOKUP_SNOMED = /^true$/i.test(process.env.USE_LOOKUP_SNOMED || 'false')
async function lookupSnomedDisplay(code) {
  if (!USE_LOOKUP_SNOMED || !TERMINOLOGY_BASE || !code) return null
  try {
    const url = `${TERMINOLOGY_BASE}/CodeSystem/$lookup`
    const { data } = await axios.get(url, {
      params: {
        system: SNOMED,
        code,
        // version opcional: version=http://snomed.info/sct/900000000000207008/version/20240331
      },
      httpsAgent: axios.defaults.httpsAgent
    })
    const p = (data?.parameter || [])
    const disp = p.find(x => x.name === 'display')?.valueString
    return disp || null
  } catch (e) {
    dbg('lookup error:', e.message)
    return null
  }
}

function buildPatientDisplay(patient) {
  if (!patient) return undefined
  const n = (patient.name && patient.name[0]) || {}
  const given = Array.isArray(n.given) ? n.given.join(' ') : n.given
  const fam = n.family || ''
  const nameStr = [given, fam].filter(Boolean).join(' ').trim()
  const idf = (patient.identifier && patient.identifier[0]) || null
  const idStr = idf?.value ? ` (ID: ${idf.value})` : ''
  return (nameStr || idStr) ? `${nameStr}${idStr}` : undefined
}

async function buildConditionFromDiagnosisGroup(groupObs, byId, patientRef, encounterRef, enc, patient) {
  // Buscar miembros relevantes del grupo
  const memberIds = (groupObs.hasMember || []).map(m => m.reference?.replace(/^Observation\//, '')).filter(Boolean)
  const members = memberIds.map(id => byId.get(id)).filter(Boolean)
  const coded = members.find(r => isCode(r, DIAG_CODED))
  const certaintyObs = members.find(r => isCode(r, DIAG_CERTAINTY))
  const orderObs = members.find(r => isCode(r, DIAG_ORDER))

  // 1) Obtener SNOMED desde valueCodeableConcept de "Coded Diagnosis"
  const valueCodings = coded?.valueCodeableConcept?.coding || []
  let snomed = valueCodings.find(c => c.system === SNOMED && c.code) || null

  // 2) Si no trae SNOMED, intentar traducir el primer coding disponible
  if (!snomed && USE_TRANSLATE) {
    const src = valueCodings.find(c => c.code) || null
    if (src) snomed = await translateToSNOMED({ system: src.system, code: src.code, display: src.display })
  }

  // 3) si sigue sin SNOMED → omitir
  if (!snomed) {
    dbg('omit diagnosis group (no SNOMED in Coded Diagnosis):', { id: groupObs.id })
    return null
  }

  // category encounter-diagnosis
  const category = [{ coding: [{ system: CC_CATEGORY, code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }]

  // clinicalStatus & verificationStatus por defecto (ajustables por ENV)
  const clinicalStatusCode = process.env.DEFAULT_COND_CLINICAL || 'active' // active | recurrence | relapse | inactive | remission | resolved
  const verificationStatusCode = process.env.DEFAULT_COND_VERIFY || 'confirmed' // unconfirmed | provisional | differential | confirmed | refuted | entered-in-error

  // code.text (prioriza display SNOMED; si no hay, usa valueCodeableConcept.text; opcionalmente lookup)
  let codeText = snomed?.display || coded?.valueCodeableConcept?.text || undefined
  if (!codeText && snomed?.code) {
    const looked = await lookupSnomedDisplay(snomed.code)
    if (looked) codeText = looked
  }

  const condition = {
    resourceType: 'Condition',
    id: `cond-${groupObs.id}`, // trazabilidad contra el grupo de diagnóstico
    meta: {
      profile: (process.env.CONDITION_PROFILE ? [process.env.CONDITION_PROFILE] : undefined)
    },
    category,
    clinicalStatus: { coding: [{ system: CC_CLINICAL, code: clinicalStatusCode }] },
    verificationStatus: { coding: [{ system: CC_VERIFY, code: verificationStatusCode }] },
    code: { coding: [snomed] }, // **solo SNOMED**
    subject: { reference: patientRef },
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    onsetDateTime: groupObs.effectiveDateTime || groupObs.issued || undefined,
    recordedDate: groupObs.issued || undefined
  }

  // code.text si lo logramos determinar
  if (codeText) condition.code.text = codeText

  // subject.display (si tenemos Patient)
  const subjDisp = buildPatientDisplay(patient)
  if (subjDisp) condition.subject.display = subjDisp

  // Asserter/recorder (si existe en Encounter: primer Practitioner)
  const prac = (enc?.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))?.individual?.reference
  if (prac) {
    condition.asserter = { reference: prac }
    // recorder (como en tu ejemplo del Condition previo)
    condition.recorder = { reference: prac }
  }

  // verificationStatus desde "Diagnosis Certainty"
  const certainty = certaintyObs?.valueCodeableConcept?.text || certaintyObs?.valueCodeableConcept?.coding?.[0]?.display
  if (certainty && /confirmed/i.test(certainty)) {
    condition.verificationStatus = { coding: [{ system: CC_VERIFY, code: 'confirmed' }] }
  }
  if (certainty && /provisional|presumed/i.test(certainty)) {
    condition.verificationStatus = { coding: [{ system: CC_VERIFY, code: 'provisional' }] }
  }

  // Narrative text (status=generated) — simple tabla HTML
  const rows = []
  rows.push(`<tr><td>Id:</td><td>${condition.id}</td></tr>`)
  rows.push(`<tr><td>Clinical Status:</td><td> ${clinicalStatusCode} </td></tr>`)
  if (codeText) rows.push(`<tr><td>Code:</td><td>${codeText}</td></tr>`)
  if (subjDisp) rows.push(`<tr><td>Subject:</td><td>${subjDisp}</td></tr>`)
  if (condition.onsetDateTime) rows.push(`<tr><td>Onset:</td><td>${condition.onsetDateTime}</td></tr>`)
  if (condition.recordedDate) rows.push(`<tr><td>Recorded Date:</td><td>${condition.recordedDate.substring(0, 10)}</td></tr>`)
  if (condition.recorder?.reference) {
    const recDisp = condition.recorder.display || 'Recorder'
    rows.push(`<tr><td>Recorder:</td><td>${recDisp}</td></tr>`)
  }
  condition.text = {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><table class="hapiPropertyTable"><tbody>${rows.join('')}</tbody></table></div>`
  }

  // Traducción opcional SNOMED \u2192 ICD-10
  try {
    const icd10Coding = await translateSnomedToICD10(snomed)
    if (icd10Coding?.code) {
      if (ICD10_MODE === 'replace') {
        condition.code.coding = [icd10Coding]
      } else {
        const exists = (condition.code.coding || []).some(c => c.system === ICD10_TARGET_SYSTEM && c.code === icd10Coding.code)
        if (!exists) condition.code.coding.push(icd10Coding)
      }
    }
  } catch (e) {
    dbg('icd10 apply error:', e.message)
  }

  return condition
}

// =============================
// Pipeline: process Conditions for an Encounter
// =============================
async function processConditionsByEncounter(enc, patient) {
  if (!enc?.id) return 0
  const encId = enc.id
  const pid = enc.subject?.reference?.split('/')[1]
  const patientRef = pid ? `Patient/${pid}` : undefined
  const encounterRef = `Encounter/${encId}`

  // Cargar Observations del Encounter (usa referencia tipada)
  const bundle = await getFromProxy(`/Observation?encounter=${encodeURIComponent('Encounter/' + encId)}&_count=200&_format=application/fhir+json`)
  if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
    logStep('ⓘ No hay Observations para el Encounter', encId)
    return 0
  }

  // Index por id y seleccionar SOLO grupos "Visit Diagnoses"
  const byId = indexById(bundle)
  const groups = bundle.entry
    .map(e => e.resource)
    .filter(r => r?.resourceType === 'Observation')
    .filter(r => isCode(r, DIAG_SET_CODE) || /Visit Diagnoses/i.test(r?.code?.text || ''))

  let sent = 0
  for (const g of groups) {
    const cond = await buildConditionFromDiagnosisGroup(g, byId, patientRef, encounterRef, enc, patient)
    if (!cond) continue
    await putToNode(cond)
    sent++
  }
  return sent
}

// =============================
// Express app
// =============================
const app = express()
app.use(express.json({ limit: '2mb' }))

const HEALTH_PATH = mediatorConfig.heartbeatPath || '/forwardercondition/_health'
app.get(HEALTH_PATH, (_req, res) => res.status(200).json({ status: 'ok', mediator: process.env.MEDIATOR_URN || mediatorConfig.urn }))

app.post('/forwardercondition/_event', async (req, res) => {
  logStep('📩 POST /forwardercondition/_event', req.body)
  const { uuid } = req.body || {}
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // Resolver Encounter + Patient
    const { enc, pid } = await resolveEncounterAndPatient(uuid)
    if (!enc) return res.status(404).json({ error: `No se encontró Encounter para uuid=${uuid}` })
    if (!pid) return res.status(404).json({ error: `Encounter sin patient (uuid=${uuid})` })

    // Subir Patient (para garantizar referencias válidas en el nodo)
    let patient
    try {
      logStep('📤 Subiendo Patient…', pid)
      patient = await getFromProxy(`/Patient/${pid}`)
      normalizePatientIdentifiers(patient)
      await putToNode(patient)
    } catch (e) {
      logStep('⚠️ No se pudo subir Patient:', e.message)
    }

    // Procesar Conditions desde Observations del Encounter
    const sent = await processConditionsByEncounter(enc, patient)

    logStep('🎉 Done conditions', { uuid, sent })
    return res.json({ status: 'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// =============================
// OpenHIM registration (respeta mediatorConfig)
// =============================
const openhimOptions = {
  apiURL: openhimConfig.apiURL,
  username: openhimConfig.username,
  password: openhimConfig.password,
  trustSelfSigned: openhimConfig.trustSelfSigned,
  urn: process.env.MEDIATOR_URN || mediatorConfig.urn
}
const me = mediatorConfig

function onRegister(err) {
  if (err) return logStep('❌ Registration failed', err)
  logStep('✅ Registered mediator', openhimOptions.urn)
  activateHeartbeat(openhimOptions, me.heartbeatInterval || 30000)
}

registerMediator(openhimOptions, me, onRegister)

const PORT = process.env.FORWARDER_CONDITION_PORT || 8014
const appServer = app.listen(PORT, () => logStep(`Condition Forwarder on port ${PORT} (health at ${HEALTH_PATH})`))

export default appServer
