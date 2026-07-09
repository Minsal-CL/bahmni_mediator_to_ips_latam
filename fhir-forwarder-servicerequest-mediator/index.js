// index.js (FHIR Event Forwarder Mediator) — Interconsulta Transfronteriza (obs) -> ServiceRequest FHIR
// Toma el Encounter del formulario "Interconsulta Transfronteriza", mapea sus observaciones a un
// ServiceRequest (perfil base R4) y referencia el último IPS del paciente vía ITI-67 (igual que el
// dashboard "IPS LAC"). Reenvía Patient/Practitioner/Encounter + ServiceRequest al nodo nacional.
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { COUNTRY_UUID_TO_ISO2 } from './countryIso.js'
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
  GROUP:            process.env.SR_CONCEPT_GROUP            || '1c756067-27fd-4353-934b-5eff5384ddcd', // obsGroup Set "interconsulta transfronteriza" (hasMember) -> 1 ServiceRequest por grupo
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

// Perfiles IG RACSEL "Interconsulta Transfronteriza" (https://ig.racsel.org)
const PROFILE_SR  = process.env.SR_PROFILE_URL  || 'http://racsel.org/StructureDefinition/LACServiceRequestIT'
const PROFILE_ORG = process.env.SR_ORG_PROFILE_URL || 'http://racsel.org/StructureDefinition/LACOrganization'
// identifier (1..*) de la solicitud
const SR_ID_SYSTEM = process.env.SR_IDENTIFIER_SYSTEM || 'http://minsal.cl/sid/servicerequest-it'
// Organización de ORIGEN (requester) — el establecimiento solicitante chileno
const ORIGIN_ORG_NAME    = process.env.SR_ORIGIN_ORG_NAME    || 'Hospital Clínico San Borja Arriarán'
const ORIGIN_ORG_COUNTRY = process.env.SR_ORIGIN_ORG_COUNTRY || 'CL' // ISO 3166-1 alpha-2
// Sistema del identifier de país en requester/performer (referencia lógica LACOrganization)
const ISO_3166_SYSTEM = process.env.SR_COUNTRY_ID_SYSTEM || 'urn:iso:std:iso:3166'

// ── Documento MHD "Interconsulta Transfronteriza" ──
// IMPORTANTE (IG RACSEL, verificado): la INTERCONSULTA (ida) viaja SOLO como ServiceRequest suelto
// (LACServiceRequestIT); NO es un documento MHD. El documento MHD es la RESPUESTA/contrarreferencia
// (LACBundleTransactionMHDIT), que emite el mediador de contrarreferencia. Por eso este bloque queda
// DESACTIVADO por defecto; se conserva tras SR_MHD_ENABLED=true solo por compatibilidad/experimentos.
const MHD_ENABLED  = (process.env.SR_MHD_ENABLED || 'false').toLowerCase() === 'true'
// Dos servidores FHIR DISTINTOS:
//   - Recurso clínico (Paso 1) -> SR_FHIR_RESOURCE_URL (default FHIR_NODE_URL) = hapilocal
//   - Documento MHD  (Paso 2)  -> SR_MHD_ENDPOINT                              = hapinacional
// Sin fallback cruzado: si SR_MHD_ENDPOINT no está, se omite el documento.
const MHD_ENDPOINT = (process.env.SR_MHD_ENDPOINT || '').replace(/\/$/, '')
// El ServiceRequest SUELTO también se registra en el NN (hapinacional) para que sea consultable
// y completable ahí (Track 1.2 T1.2-B/G). Base = hapinacional sin /fhir (putToNode agrega /fhir).
const NATIONAL_RESOURCE_BASE = (process.env.SR_NATIONAL_RESOURCE_URL || MHD_ENDPOINT.replace(/\/fhir\/?$/, '')).replace(/\/$/, '')
const PROFILE_COMP    = process.env.SR_COMPOSITION_PROFILE || 'http://racsel.org/StructureDefinition/LACCompositionIT'
const PROFILE_DOCBNDL = process.env.SR_DOCBUNDLE_PROFILE   || 'http://racsel.org/StructureDefinition/LACBundleDocIT'
const PROFILE_DOCREF  = process.env.SR_DOCREF_PROFILE      || 'http://racsel.org/StructureDefinition/LACDocReferenceIT'
const PROFILE_TXBNDL  = process.env.SR_TXBUNDLE_PROFILE    || 'http://racsel.org/StructureDefinition/LACBundleTransactionMHDIT'
const COMP_TYPE    = { system: 'http://loinc.org', code: '11488-4', display: 'Consultation note' }
const SECTION_CODE = { system: 'http://loinc.org', code: '55112-7', display: 'Document summary' }
const SECTION_TITLE = 'Resultado de la Evaluación'
const MASTER_ID_SYSTEM = process.env.SR_MASTER_ID_SYSTEM || 'urn:ietf:rfc:3986'

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
// Nodo de recursos clínicos (Paso 1) — distinto del MHD (Paso 2)
const RESOURCE_BASE = (process.env.SR_FHIR_RESOURCE_URL || process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
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

async function putToNode(resource, orch, base = RESOURCE_BASE) {
  const url = `${base}/fhir/${resource.resourceType}/${resource.id}`
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

// Registra el recurso suelto también en el Nodo Nacional (best-effort, no rompe el flujo).
async function putToNational(resource, orch) {
  if (!NATIONAL_RESOURCE_BASE) return
  try { await putToNode(resource, orch, NATIONAL_RESOURCE_BASE) }
  catch (e) { logStep('⚠️ No se pudo registrar en el NN', resource.resourceType, resource.id, ':', e.message) }
}

// Busca un ServiceRequest existente por su identifier de negocio (SR_ID_SYSTEM|value), no por el id
// interno del servidor (que en creación aún no se conoce).
async function findServiceRequestByIdentifier(srId, base) {
  const idParam = `${encodeURIComponent(SR_ID_SYSTEM)}%7C${encodeURIComponent(srId)}`
  const url = `${base}/fhir/ServiceRequest?identifier=${idParam}&_count=1`
  logStep('GET (node, buscar SR existente)', url)
  const r = await axios.get(url, {
    headers: { Accept: 'application/fhir+json' },
    validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (r.status >= 400) return undefined
  return (r.data?.entry || [])[0]?.resource
}

// Crea (POST) el ServiceRequest si no existe todavía un recurso con ese identifier de negocio en el
// destino; si ya existe, lo actualiza (PUT) — así una reejecución del evento (ej. edición del form)
// actualiza el estado del recurso existente en lugar de intentar recrearlo. Muta sr.id con el id real
// del servidor para que las referencias/orquestaciones posteriores usen el id correcto.
async function upsertServiceRequest(sr, orch, base = RESOURCE_BASE) {
  const srId = sr.identifier?.[0]?.value || sr.id
  const existing = await findServiceRequestByIdentifier(srId, base).catch(() => undefined)

  if (existing?.id) {
    sr.id = existing.id
    return putToNode(sr, orch, base)
  }

  const { id, ...createBody } = sr // POST: el id lo asigna el servidor
  const url = `${base}/fhir/ServiceRequest`
  logStep('POST (node)', url)
  const r = await axios.post(url, createBody, {
    headers: { 'Content-Type': 'application/fhir+json' },
    validateStatus: false, httpsAgent: axios.defaults.httpsAgent || devAgent
  })
  if (orch) orch.push(mkOrch('POST ServiceRequest', 'POST', url, createBody, r))
  if (r.status >= 400) {
    logStep('❌ POST failed payload:', JSON.stringify(r.data, null, 2))
    throw new Error(`POST failed ${r.status}`)
  }
  sr.id = r.data?.id || sr.id
  logStep('✅ POST OK', 'ServiceRequest', sr.id, r.status)
  return r.status
}

// Igual que upsertServiceRequest pero best-effort contra el Nodo Nacional (no rompe el flujo).
async function upsertServiceRequestNational(sr, orch) {
  if (!NATIONAL_RESOURCE_BASE) return
  try { await upsertServiceRequest(sr, orch, NATIONAL_RESOURCE_BASE) }
  catch (e) { logStep('⚠️ No se pudo registrar SR en el NN', sr.id, ':', e.message) }
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
  // supportingInfo del IG (LACServiceRequestIT) referencia el Bundle IPS (LACBundleIPS):
  // tomamos la URL del attachment del DocumentReference; si no hay, caemos al propio DocumentReference.
  let ref = (dr.content || []).map(c => c?.attachment?.url).find(Boolean)
        || entry.fullUrl || `${REGIONAL_BASE}/DocumentReference/${dr.id}`
  // El IPS vive en el servidor regional; si la ref es relativa la hacemos ABSOLUTA para que resuelva
  // desde otros servidores (hapilocal/hapinacional).
  if (ref && !/^https?:\/\//i.test(ref)) ref = `${REGIONAL_BASE}/${String(ref).replace(/^\//, '')}`
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
// Construye el ServiceRequest conforme al perfil LACServiceRequestIT (IG RACSEL Interconsulta Transfronteriza).
// requester = Organización de ORIGEN; performer = Organización de DESTINO; ambas LACOrganization contenidas.
function buildServiceRequest({ id, encId, patientRef, authoredOn, byConcept, ipsRef, originOrgName }) {
  const srId = id || encId
  const referredTo  = obsValueString(byConcept[CONCEPT.REFERRED_TO])
  const reason      = obsValueString(byConcept[CONCEPT.REASON_TEXT])
  const note        = obsValueString(byConcept[CONCEPT.CLINICAL_HISTORY])
  const destName    = obsValueString(byConcept[CONCEPT.ORG_DEST])
  const country     = obsCountry(byConcept[CONCEPT.COUNTRY_DEST])
  const destCountry = country?.iso2 || country?.display // ISO 3166-1 alpha-2

  // requester (ORIGEN) y performer (DESTINO) = Reference(LACOrganization) NO contenidas.
  // El IG (ejemplo Track 1.2) usa referencias LÓGICAS: { identifier, display }, sin contained ni
  // address.country dentro del SR. El país viaja en identifier (ISO 3166-1) + el nombre en display.
  const requester = {
    identifier: { system: ISO_3166_SYSTEM, value: ORIGIN_ORG_COUNTRY },
    display: originOrgName || ORIGIN_ORG_NAME
  }
  const performer = {
    identifier: { system: ISO_3166_SYSTEM, value: destCountry || 'XX' },
    display: destName || country?.display || 'Organización de destino'
  }

  if (!ipsRef) logStep('⚠️ Sin IPS: el perfil LACServiceRequestIT exige supportingInfo (1..1)')

  const sr = {
    resourceType: 'ServiceRequest',
    id: srId, // un ServiceRequest por grupo de interconsulta (o por Encounter en modo plano)
    meta: { profile: [PROFILE_SR] },
    identifier: [{ system: SR_ID_SYSTEM, value: srId }],
    status: SR_STATUS,
    intent: SR_INTENT,
    category: [{ text: SR_CATEGORY_TEXT }],
    code: { text: referredTo || SR_CATEGORY_TEXT },
    subject: { reference: patientRef },
    // Nota: NO se referencia el Encounter. Es una referencia interna de OpenMRS (solo existe en
    // hapilocal) y el nodo nacional, con integridad referencial, rechazaba el SR (HAPI-1094).
    // Además LACServiceRequestIT no requiere encounter.
    ...(authoredOn ? { authoredOn } : {}),
    requester,
    performer: [performer],
    ...(reason ? { reasonCode: [{ text: reason }] } : {}),
    ...(note ? { note: [{ text: note }] } : {}),
    ...(ipsRef ? { supportingInfo: [ipsRef] } : {})
  }
  return sr
}

// ============================================================================
// Documento MHD (Fase 2): Composition + Document Bundle + DocumentReference + List → transacción
// ============================================================================
function buildAuthorOrg() {
  return { resourceType: 'Organization', meta: { profile: [PROFILE_ORG] }, name: ORIGIN_ORG_NAME, address: [{ country: ORIGIN_ORG_COUNTRY }] }
}

function buildComposition({ patientRef, authorUrl, srUrls, date, narrative }) {
  return {
    resourceType: 'Composition',
    meta: { profile: [PROFILE_COMP] },
    status: 'final',
    type: { coding: [COMP_TYPE], text: COMP_TYPE.display },
    subject: { reference: patientRef },
    date,
    author: [{ reference: authorUrl }],
    title: 'Interconsulta Transfronteriza',
    section: [{
      title: SECTION_TITLE,
      code: { coding: [SECTION_CODE] },
      text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${narrative}</div>` },
      entry: srUrls.map(u => ({ reference: u }))
    }]
  }
}

// Ensambla la transacción MHD (LACBundleTransactionMHDIT) con el documento embebido (1+ ServiceRequest).
function buildMhdTransaction({ patient, serviceRequests, date }) {
  const u = () => `urn:uuid:${randomUUID()}`
  const patientRef = `Patient/${patient.id}`
  const authorUrl = u(), compUrl = u(), docBundleUrl = u(), docRefUrl = u(), listUrl = u()
  const srEntries = serviceRequests.map(sr => ({ url: u(), res: sr }))

  const authorOrg   = buildAuthorOrg()
  const narrative   = 'Interconsulta transfronteriza: ' + (serviceRequests.map(sr => `${sr.code?.text || 'especialidad'} → ${sr.performer?.[0]?.display || 's/d'}`).join('; ') || 's/d')
  const composition = buildComposition({ patientRef, authorUrl, srUrls: srEntries.map(e => e.url), date, narrative })

  // Document Bundle (LACBundleDocIT, type document)
  const docBundle = {
    resourceType: 'Bundle', meta: { profile: [PROFILE_DOCBNDL] }, type: 'document',
    identifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl }, timestamp: date,
    entry: [
      { fullUrl: compUrl,    resource: composition },
      { fullUrl: authorUrl,  resource: authorOrg },
      { fullUrl: patientRef, resource: patient },
      ...srEntries.map(e => ({ fullUrl: e.url, resource: e.res }))
    ]
  }

  // DocumentReference (LACDocReferenceIT)
  const docRef = {
    resourceType: 'DocumentReference', meta: { profile: [PROFILE_DOCREF] },
    masterIdentifier: { system: MASTER_ID_SYSTEM, value: docBundleUrl },
    status: 'current',
    type: { coding: [COMP_TYPE] },
    subject: { reference: patientRef },
    date,
    content: [{ attachment: { contentType: 'application/fhir+json', url: docBundleUrl } }]
  }

  // List / SubmissionSet (LACList)
  const list = { resourceType: 'List', status: 'current', mode: 'working', date, entry: [{ item: { reference: docRefUrl } }] }

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
  const url = MHD_ENDPOINT
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
app.get(['/forwarderservicerequest/_health', '/forwarderServiceRequest/_health'], (_req, res) => res.send('OK'))

app.post(['/forwarderservicerequest/_event', '/forwarderServiceRequest/_event'], async (req, res) => {
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
    const membersOf = g => (g.hasMember || []).map(m => byId[m.reference?.split('/').pop()]).filter(Boolean)

    // Unidades de interconsulta: preferir el obs grupo "interconsulta transfronteriza" (hasMember) → 1 SR por grupo;
    // si no hay grupos, fallback plano (una interconsulta con las obs del encuentro).
    const fieldConcepts = [CONCEPT.REFERRED_TO, CONCEPT.REASON_TEXT, CONCEPT.CLINICAL_HISTORY, CONCEPT.COUNTRY_DEST, CONCEPT.ORG_DEST]
    const groups = observations.filter(o => obsHasConcept(o, CONCEPT.GROUP))
    let units = groups.length
      ? groups.map(g => ({ id: g.id, byConcept: indexObsByConcept(membersOf(g)) }))
      : [{ id: uuid, byConcept: indexObsByConcept(observations) }]
    units = units.filter(u => fieldConcepts.some(c => u.byConcept[c]))
    if (!units.length) {
      logStep('ⓘ El Encounter no tiene observaciones de Interconsulta Transfronteriza', uuid)
      return res.json({ status: 'skip', uuid, reason: 'no interconsulta obs' })
    }

    // 3) Patient (para identificador nacional + subir referencia) — local y NN
    const patient = await getFromProxy(`/Patient/${pid}`)
    normalizePatientIdentifiers(patient)
    await putToNode(patient, orch); sent++
    await putToNational(patient, orch) // para que el SR suelto resuelva su subject en el NN

    // 4) Practitioner del Encounter (best-effort; queda en el Encounter, el requester del SR es la org de origen)
    const practitionerRef = pickPractitionerRef(observations, enc)
    if (practitionerRef?.startsWith('Practitioner/')) {
      try { const prac = await getFromProxy(`/${practitionerRef}`); await putToNode(prac, orch); sent++ }
      catch (e) { logStep('⚠️ No se pudo subir Practitioner:', e.message) }
    }

    // 5) Encounter (best-effort, para la referencia)
    try { await putToNode(enc, orch); sent++ } catch (e) { logStep('⚠️ No se pudo subir Encounter:', e.message) }

    // 6) Último IPS del paciente (ITI-67, probando RUN y Pasaporte) — una vez por paciente
    const ipsRef = await fetchLatestIps(patient)
    const authoredOn = pickAuthoredOn(observations, enc)
    const originOrgName = enc.serviceProvider?.display // org de origen = serviceProvider del Encounter

    // 7) Un ServiceRequest por unidad/grupo (perfil LACServiceRequestIT)
    const srResources = []
    for (const u of units) {
      const sr = buildServiceRequest({ id: u.id, encId: uuid, patientRef, authoredOn, byConcept: u.byConcept, ipsRef, originOrgName })
      await upsertServiceRequest(sr, orch); sent++; srResources.push(sr)
      await upsertServiceRequestNational(sr, orch) // SR suelto también en el NN (Track 1.2: consultable/completable ahí)
    }

    // 8) Documento MHD "Interconsulta Transfronteriza" (Fase 2) con todos los ServiceRequest
    let mhd = false
    if (MHD_ENABLED && srResources.length) {
      if (!MHD_ENDPOINT) {
        logStep('⚠️ MHD habilitado pero sin endpoint (SR_MHD_ENDPOINT) — se omite el documento')
      } else {
        const tx = buildMhdTransaction({ patient, serviceRequests: srResources, date: authoredOn || new Date().toISOString() })
        dumpBundle('servicerequest', uuid, tx) // copia en carpeta (evidencia)
        try { await submitMhd(tx, orch); mhd = true }
        catch (e) { logStep('⚠️ No se pudo enviar el documento MHD:', e.message) }
      }
    }

    logStep('🎉 Done ServiceRequest', uuid, '| SR:', srResources.length, '| IPS:', ipsRef?.reference || '—', '| MHD:', mhd)
    sendOpenhim(res, { status: 'ok', uuid, sent, serviceRequests: srResources.map(s => s.id), ips: ipsRef?.reference || null, mhd }, orch)
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_SERVICEREQUEST_PORT || 8016
app.listen(PORT, () => logStep(`FHIR Forwarder ServiceRequest on port ${PORT}`))
