// index.js (FHIR Event Forwarder Mediator) — Interconsulta Transfronteriza (obs) -> ServiceRequest FHIR
// Toma el Encounter del formulario "Interconsulta Transfronteriza", mapea sus observaciones a un
// ServiceRequest (perfil base R4) y referencia el último IPS del paciente vía ITI-67 (igual que el
// dashboard "IPS LAC"). Reenvía Patient/Practitioner/Encounter + ServiceRequest al nodo nacional.
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
import { COUNTRY_UUID_TO_ISO2 } from './countryIso.js'
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

// HTTPS agent for development (self-signed)
const devAgent = new https.Agent({ rejectUnauthorized: false })
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = devAgent
  console.log('⚠️  DEV MODE: self-signed certs accepted')
}

function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err)
    process.exit(1)
  }
  console.log('✅ Forwarder ServiceRequest registered')

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
  ).then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// ============================================================================
// Configuración de mapeo
// ============================================================================
// UUIDs de los conceptos del formulario "Interconsulta Transfronteriza".
// (todos verificados en standard-config/.../bahmniforms/lac_service_request_interconsulta_sin_ips.json)
const CONCEPT = {
  REFERRED_TO:      process.env.SR_CONCEPT_REFERRED_TO      || '9bb0795c-4ff0-0305-1990-000000000042', // -> code.text
  REASON_TEXT:      process.env.SR_CONCEPT_REASON_TEXT      || '164359AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // -> reasonCode.text
  CLINICAL_HISTORY: process.env.SR_CONCEPT_CLINICAL_HISTORY || '9bb0795c-4ff0-0305-1990-000000000043', // -> note.text (Texto de carta)
  COUNTRY_DEST:     process.env.SR_CONCEPT_COUNTRY_DEST     || '19110fa3-2243-4e7d-8092-afc525573f3a', // -> Organization destino (address.country); answers = países CIEL
  ORG_DEST:         process.env.SR_CONCEPT_ORG_DEST         || '75cf9a9e-8bdf-4f76-a701-fa6f05f72e36'  // -> Organization destino (name)
}

// Constantes FHIR (configurables). status/intent son obligatorios en ServiceRequest R4.
const SR_STATUS        = process.env.SR_STATUS        || 'active'        // draft|active|on-hold|revoked|completed|...
const SR_INTENT        = process.env.SR_INTENT        || 'order'         // proposal|plan|order|...
const SR_CATEGORY_TEXT = process.env.SR_CATEGORY_TEXT || 'Interconsulta' // Tipo de derivación (respuesta única)

// IPS (ITI-67) — mismo origen que el dashboard "IPS LAC" (ipsConfig.js)
const IPS_TYPE_LOINC = process.env.IPS_TYPE_LOINC || '60591-5' // LOINC "Patient summary document"
const REGIONAL_BASE  = (process.env.IPS_REGIONAL_BASE || 'https://apiopenhim.nodonacionalph4h-dev.minsal.cl/regional').replace(/\/$/, '')
const IPS_BASIC_USER = process.env.IPS_BASIC_USER || process.env.OPENHIM_USER
const IPS_BASIC_PASS = process.env.IPS_BASIC_PASS || process.env.OPENHIM_PASS
// Identificadores con los que buscar el IPS (ITI-67), en orden de preferencia:
// RUN/RUT (paciente chileno) y luego Pasaporte (extranjero — caso típico transfronterizo).
const NATIONAL_ID_TYPE_TEXT = process.env.SR_NATIONAL_ID_TYPE_TEXT || 'Patient Identifier'
const PASSPORT_ID_TYPE_TEXT = process.env.SR_PASSPORT_ID_TYPE_TEXT || 'Pasaporte'

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
function obsHasConcept(obs, conceptUuid) { return codeList(obs).includes(conceptUuid) }
function indexObsByConcept(observations) {
  // Devuelve el primer obs por concepto (las obs del form son planas, una por concepto)
  const map = {}
  for (const o of observations) {
    for (const c of codeList(o)) if (!map[c]) map[c] = o
  }
  return map
}
function obsValueString(o) {
  if (!o) return undefined
  if (typeof o.valueString === 'string') return o.valueString
  if (o.valueCodeableConcept) return o.valueCodeableConcept.text || o.valueCodeableConcept.coding?.[0]?.display
  return undefined
}
function obsCountry(o) {
  // "Pais de destino" es Coded -> valueCodeableConcept. El code de cada coding es el UUID del
  // concepto CIEL; lo mapeamos a ISO 3166-1 alpha-2 (HL7 v3 Country2) con COUNTRY_UUID_TO_ISO2.
  const cc = o?.valueCodeableConcept
  if (!cc) return undefined
  let iso2
  for (const c of (cc.coding || [])) {
    if (c.code && COUNTRY_UUID_TO_ISO2[c.code]) { iso2 = COUNTRY_UUID_TO_ISO2[c.code]; break }
  }
  return { display: cc.text || cc.coding?.[0]?.display, code: cc.coding?.[0]?.code, iso2 }
}

// requester: primero Observation.performer (Practitioner), si no, Encounter.participant
function pickPractitionerRef(observations, enc) {
  for (const o of observations) {
    const p = (o.performer || []).find(x => x.reference?.startsWith('Practitioner/'))
    if (p) return p.reference
  }
  const x = (enc.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))
  return x?.individual?.reference
}
// authoredOn: effectiveDateTime de cualquier obs del form, si no, fecha del Encounter
function pickAuthoredOn(observations, enc) {
  for (const o of observations) {
    if (o.effectiveDateTime) return o.effectiveDateTime
    if (o.issued) return o.issued
  }
  return enc.period?.start || enc.period?.end || undefined
}

// ============================================================================
// IPS: último DocumentReference del paciente (ITI-67), igual que el dashboard
// ============================================================================
// Identificadores candidatos para buscar el IPS, en orden: RUN/RUT, luego Pasaporte, luego el resto.
// Se limpia cualquier prefijo de tipo ("rut*", "RUN*", "PPN*", …) antes de usarlos.
function patientSearchIdentifiers(patient) {
  const ids = Array.isArray(patient?.identifier) ? patient.identifier : []
  const byType = t => ids.filter(id => (id.type?.text || '') === t).map(id => id.value)
  const ordered = [...byType(NATIONAL_ID_TYPE_TEXT), ...byType(PASSPORT_ID_TYPE_TEXT), ...ids.map(id => id.value)]
  const clean = v => String(v || '').replace(/^[A-Za-z]+\*/, '').trim()
  return [...new Set(ordered.map(clean).filter(Boolean))]
}

async function queryIpsByIdentifier(identifier) {
  const url = `${REGIONAL_BASE}/DocumentReference` +
    `?patient.identifier=${encodeURIComponent(identifier)}&type=${IPS_TYPE_LOINC}&_sort=-_lastUpdated&_count=1`
  logStep('IPS ITI-67 GET', url)
  const auth = IPS_BASIC_USER && IPS_BASIC_PASS ? { username: IPS_BASIC_USER, password: IPS_BASIC_PASS } : undefined
  const res = await axios.get(url, {
    headers: { Accept: 'application/fhir+json' },
    auth, validateStatus: false, timeout: 15000,
    httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (res.status >= 400) { logStep('⚠️ ITI-67 status', res.status, 'para', identifier); return undefined }
  const entry = (res.data?.entry || [])[0]
  const dr = entry?.resource
  if (!dr || dr.resourceType !== 'DocumentReference') return undefined
  const ref = entry.fullUrl || `${REGIONAL_BASE}/DocumentReference/${dr.id}`
  return { reference: ref, display: `IPS (${dr.date || dr.meta?.lastUpdated || ''})`.trim() }
}

// Busca el último IPS del paciente probando cada identificador (RUN, Pasaporte, …) hasta encontrarlo.
async function fetchLatestIps(patient) {
  const candidates = patientSearchIdentifiers(patient)
  if (!candidates.length) { logStep('ⓘ Paciente sin identificadores para ITI-67'); return undefined }
  for (const id of candidates) {
    try {
      const hit = await queryIpsByIdentifier(id)
      if (hit) return hit
    } catch (e) {
      logStep('⚠️ Error ITI-67 (silenciado) para', id, ':', e?.message || e)
    }
  }
  logStep('ⓘ Sin IPS para', candidates.join(', '))
  return undefined
}

// ============================================================================
// Construcción del ServiceRequest
// ============================================================================
function buildServiceRequest({ encId, patientRef, requesterRef, authoredOn, byConcept, ipsRef }) {
  const referredTo = obsValueString(byConcept[CONCEPT.REFERRED_TO])
  const reason     = obsValueString(byConcept[CONCEPT.REASON_TEXT])
  const note       = obsValueString(byConcept[CONCEPT.CLINICAL_HISTORY])
  const orgName    = obsValueString(byConcept[CONCEPT.ORG_DEST])
  const country    = obsCountry(byConcept[CONCEPT.COUNTRY_DEST])

  // Organización destino (contenida): nombre libre + país (address.country)
  let contained, performer
  if (orgName || country) {
    // address.country (FHIR string) = ISO 3166-1 alpha-2 si lo resolvimos; si no, el display como fallback
    const countryStr = country?.iso2 || country?.display
    const org = {
      resourceType: 'Organization',
      id: 'dest-org',
      ...(orgName ? { name: orgName } : {}),
      ...(countryStr ? { address: [{ country: countryStr }] } : {})
    }
    contained = [org]
    performer = [{ reference: '#dest-org', ...(orgName ? { display: orgName } : {}) }]
  }

  const sr = {
    resourceType: 'ServiceRequest',
    id: encId, // un ServiceRequest por Encounter (upsert por re-envío)
    status: SR_STATUS,
    intent: SR_INTENT,
    category: [{ text: SR_CATEGORY_TEXT }],
    ...(referredTo ? { code: { text: referredTo } } : {}),
    subject: { reference: patientRef },
    encounter: { reference: `Encounter/${encId}` },
    ...(authoredOn ? { authoredOn } : {}),
    ...(requesterRef ? { requester: { reference: requesterRef } } : {}),
    ...(reason ? { reasonCode: [{ text: reason }] } : {}),
    ...(note ? { note: [{ text: note }] } : {}),
    ...(contained ? { contained } : {}),
    ...(performer ? { performer } : {}),
    ...(ipsRef ? { supportingInfo: [ipsRef] } : {})
  }
  return sr
}

// ============================================================================
// Endpoints
// ============================================================================
app.get(['/forwarderservicerequest/_health', '/forwarderServiceRequest/_health'], (_req, res) => res.send('OK'))

app.post(['/forwarderservicerequest/_event', '/forwarderServiceRequest/_event'], async (req, res) => {
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

    // 2) Observaciones del Encounter (form plano)
    const obsBundle = await getFromProxy(`/Observation?encounter=Encounter/${encodeURIComponent(uuid)}&_count=200&_format=application/fhir+json`)
    const observations = (obsBundle.entry || []).map(e => e.resource).filter(r => r?.resourceType === 'Observation')
    const byConcept = indexObsByConcept(observations)
    const wanted = Object.values(CONCEPT)
    if (!wanted.some(c => byConcept[c])) {
      logStep('ⓘ El Encounter no tiene observaciones de Interconsulta Transfronteriza', uuid)
      return res.json({ status: 'skip', uuid, reason: 'no interconsulta obs' })
    }

    // 3) Patient (para identificador nacional + subir referencia)
    const patient = await getFromProxy(`/Patient/${pid}`)
    await putToNode(patient); sent++

    // 4) Practitioner solicitante (best-effort)
    const requesterRef = pickPractitionerRef(observations, enc)
    if (requesterRef?.startsWith('Practitioner/')) {
      try { const prac = await getFromProxy(`/${requesterRef}`); await putToNode(prac); sent++ }
      catch (e) { logStep('⚠️ No se pudo subir Practitioner solicitante:', e.message) }
    }

    // 5) Encounter (best-effort, para la referencia)
    try { await putToNode(enc); sent++ } catch (e) { logStep('⚠️ No se pudo subir Encounter:', e.message) }

    // 6) Último IPS del paciente (ITI-67, probando RUN y Pasaporte) -> supportingInfo
    const ipsRef = await fetchLatestIps(patient)

    // 7) Construir y subir el ServiceRequest
    const authoredOn = pickAuthoredOn(observations, enc)
    const sr = buildServiceRequest({ encId: uuid, patientRef, requesterRef, authoredOn, byConcept, ipsRef })
    await putToNode(sr); sent++

    logStep('🎉 Done ServiceRequest', uuid, '| IPS:', ipsRef?.reference || '—')
    res.json({ status: 'ok', uuid, sent, serviceRequest: sr.id, ips: ipsRef?.reference || null })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_SERVICEREQUEST_PORT || 8016
app.listen(PORT, () => logStep(`FHIR Forwarder ServiceRequest on port ${PORT}`))
