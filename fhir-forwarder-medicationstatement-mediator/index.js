// index.js (FHIR Event Forwarder Mediator) — Reporte Medicamentos (obs) -> MedicationStatement FHIR
// Toma el Encounter del formulario "Reporte Medicamentos", mapea sus observaciones a uno o más
// MedicationStatement (perfil LACMedicationStatementMeOw del IG RACSEL) y los reenvía al nodo nacional.
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
const require = createRequire(import.meta.url)
const mediatorConfig = require('./mediatorConfig.json')

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
const MHD_ENDPOINT = (process.env.MS_MHD_ENDPOINT || `${(process.env.FHIR_NODE_URL || '').replace(/\/$/, '')}/fhir`).replace(/\/$/, '')
const PROFILE_COMP    = process.env.MS_COMPOSITION_PROFILE || 'http://racsel.org/StructureDefinition/LACCompositionMeOw'
const PROFILE_DOCBNDL = process.env.MS_DOCBUNDLE_PROFILE   || 'http://racsel.org/StructureDefinition/LACBundleDocMeOw'
const PROFILE_DOCREF  = process.env.MS_DOCREF_PROFILE      || 'http://racsel.org/StructureDefinition/LACDocReferenceMeOw'
const PROFILE_TXBNDL  = process.env.MS_TXBUNDLE_PROFILE    || 'http://racsel.org/StructureDefinition/LACBundleTransactionMHDMeOw'
const PROFILE_ORG_LAC = process.env.MS_ORG_PROFILE_URL     || 'http://racsel.org/StructureDefinition/LACOrganization'
const COMP_TYPE     = { system: 'http://loinc.org', code: '56445-0', display: 'Medication summary' }
const SECTION_CODE  = { system: 'http://loinc.org', code: '55112-7', display: 'Medication summary' }
const MASTER_ID_SYSTEM   = process.env.MS_MASTER_ID_SYSTEM   || 'urn:ietf:rfc:3986'
const AUTHOR_ORG_NAME    = process.env.MS_AUTHOR_ORG_NAME    || 'Hospital Clínico San Borja Arriarán'
const AUTHOR_ORG_COUNTRY = process.env.MS_AUTHOR_ORG_COUNTRY || 'CL'

// ============================================================================
// Fuentes (proxy FHIR de OpenMRS) y destino (nodo nacional)
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

async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  logStep('PUT (node)', url)
  const r = await axios.put(url, resource, {
    headers: { 'Content-Type': 'application/fhir+json' },
    validateStatus: false,
    httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (r.status >= 400) {
    logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
    throw new Error(`PUT failed ${r.status}`)
  }
  logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
  return r.status
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
function buildAuthorOrg() {
  return { resourceType: 'Organization', meta: { profile: [PROFILE_ORG_LAC] }, name: AUTHOR_ORG_NAME, address: [{ country: AUTHOR_ORG_COUNTRY }] }
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
  const patientUrl = u(), authorUrl = u(), compUrl = u(), docBundleUrl = u(), docRefUrl = u(), listUrl = u()
  const msEntries = msResources.map(ms => ({ url: u(), res: ms }))

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

  // DocumentReference (LACDocReferenceMeOw)
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [PROFILE_DOCREF] },
    masterIdentifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current',
    type: { coding: [COMP_TYPE] },
    subject: { reference: `Patient/${patient.id}` },
    date,
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

async function submitMhd(txBundle) {
  const url = MHD_ENDPOINT // POST de la transacción
  logStep('POST (MHD)', url)
  const r = await axios.post(url, txBundle, {
    headers: { 'Content-Type': 'application/fhir+json' },
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
    validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (r.status >= 400) { logStep('❌ MHD POST falló:', r.status, JSON.stringify(r.data).slice(0, 800)); throw new Error(`MHD POST ${r.status}`) }
  logStep('✅ MHD OK', r.status)
  return r.status
}

// ============================================================================
// Endpoints
// ============================================================================
app.get(['/forwardermedicationstatement/_health', '/forwarderMedicationStatement/_health'], (_req, res) => res.send('OK'))

app.post(['/forwardermedicationstatement/_event', '/forwarderMedicationStatement/_event'], async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  let sent = 0
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
    await putToNode(patient); sent++

    // 4) Un MedicationStatement por unidad/grupo (cada uno con su Dosis/Vía pareadas)
    const created = []
    const msResources = []
    for (const u of units) {
      const ms = buildMedicationStatement({
        id: u.id, patientRef, encId: uuid, effective, medObs: u.medObs, doseText: u.doseText, routeText: u.routeText
      })
      if (!ms.medicationCodeableConcept) { logStep('⚠️ Medicamento sin código, se omite', u.id); continue }
      await putToNode(ms); sent++; created.push(ms.id); msResources.push(ms)
    }

    // 6) Documento MHD "Reporte Medicamentos" (Fase 2) — Composition + Document Bundle + DocumentReference
    let mhd = false
    if (MHD_ENABLED && msResources.length) {
      try {
        const tx = buildMhdTransaction({ patient, msResources, date: effective || new Date().toISOString() })
        await submitMhd(tx); mhd = true
      } catch (e) { logStep('⚠️ No se pudo enviar el documento MHD:', e.message) }
    }

    logStep('🎉 Done MedicationStatement', uuid, '| creados:', created.length, '| MHD:', mhd)
    res.json({ status: 'ok', uuid, sent, medicationStatements: created, mhd })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_MEDICATIONSTATEMENT_PORT || 8017
app.listen(PORT, () => logStep(`FHIR Forwarder MedicationStatement on port ${PORT}`))
