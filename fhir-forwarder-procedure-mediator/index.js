// index.js (FHIR Event Forwarder Mediator) — Observations -> IPS Procedure
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
import { createRequire } from 'module'
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
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false })
  console.log('⚠️  DEV MODE: self-signed certs accepted')
}

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err)
    process.exit(1)
  }
  console.log('✅ Forwarder registered')

  Promise.all(
    mediatorConfig.defaultChannelConfig.map(ch =>
      axios.post(
        `${openhimConfig.apiURL}/channels`,
        { ...ch, mediator_urn: mediatorConfig.urn },
        { auth: { username: openhimConfig.username, password: openhimConfig.password } }
      )
      .then(() => console.log(`✅ Channel created: ${ch.name}`))
      .catch(e => console.error(`❌ Channel ${ch.name} error:`, e.response?.data || e.message))
    )
  ).then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// 2) seen.json: track last versionId per uuid
const SEEN_FILE = './seen.json'
let seenVersions = {}
try {
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  const raw = fs.readFileSync(SEEN_FILE, 'utf8').trim()
  seenVersions = raw ? JSON.parse(raw) : {}
} catch (e) {
  console.warn('⚠️ Could not parse seen.json, re-initializing:', e.message)
  seenVersions = {}
  try { fs.writeFileSync(SEEN_FILE, '{}', 'utf8') } catch (err) { console.error('❌ Could not overwrite seen.json:', err) }
}
function saveSeen() { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions), 'utf8') } catch (err) { console.error('❌ Could not write seen.json:', err) } }

// 3) retry helper
const MAX_RETRIES = 3
async function retryRequest(fn, max = MAX_RETRIES) {
  let attempt = 0, lastErr
  while (attempt < max) {
    try { return await fn() }
    catch (e) {
      lastErr = e; attempt++
      console.warn(`⏳ Retry ${attempt}/${max}:`, e.message)
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}
function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

const SNOMED_SYSTEM = 'http://snomed.info/sct'

function filterCodingsToSnomed(cc) {
  if (!cc || !Array.isArray(cc.coding)) return
  cc.coding = cc.coding.filter(c => c.system === SNOMED_SYSTEM)
  if (cc.coding.length === 0) delete cc.coding
}

function sanitizeProcedure(proc) {
  if (!proc || proc.resourceType !== 'Procedure') return proc
  if (proc.code) {
    filterCodingsToSnomed(proc.code)
    if (!proc.code.coding && !proc.code.text) proc.code.text = 'Procedure'
  }
  if (Array.isArray(proc.bodySite)) {
    proc.bodySite = proc.bodySite
      .map(site => {
        if (!site) return null
        filterCodingsToSnomed(site)
        if (!site.coding && !site.text) return null
        return site
      })
      .filter(Boolean)
    if (proc.bodySite.length === 0) delete proc.bodySite
  }
  if (proc.outcome) {
    filterCodingsToSnomed(proc.outcome)
    if (!proc.outcome.coding && !proc.outcome.text) delete proc.outcome
  }
  return proc
}

function sanitizeCondition(cond) {
  if (!cond || cond.resourceType !== 'Condition') return cond
  if (cond.code) {
    filterCodingsToSnomed(cond.code)
    if (!cond.code.coding && !cond.code.text) cond.code.text = 'Condition'
  }
  return cond
}

// 4) FHIR proxy calls
// FHIR_PROXY_URL must include the full prefix, e.g.
//   FHIR_PROXY_URL=https://10.68.174.206:5000/proxy/fhir
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
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

// 5) PUT al FHIR Node
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  try {
    logStep('PUT (node)', url)
    const payload = JSON.parse(JSON.stringify(resource))
    if (payload?.resourceType === 'Procedure') sanitizeProcedure(payload)
    else if (payload?.resourceType === 'Condition') sanitizeCondition(payload)
    const r = await axios.put(url, payload, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false,
      httpsAgent: axios.defaults.httpsAgent
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      throw new Error(`PUT failed ${r.status}`)
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return r.status
  } catch (e) {
    if (e.response?.data) logStep('❌ Axios error body:', JSON.stringify(e.response.data, null, 2))
    throw e
  }
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

// --- caches de subida para evitar duplicados ---
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedObservations  = new Set()
const uploadedPractitioners = new Set()

// recursion para Location.partOf
async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return;
  const loc = await getFromProxy(`/Location/${locId}`)
  const parentRef = loc.partOf?.reference
  if (parentRef?.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1]
    await uploadLocationWithParents(parentId)
  }
  await putToNode(loc)
  uploadedLocations.add(locId)
}

// recursion para Encounter.partOf
async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return
  const encRes = await getFromProxy(`/Encounter/${encId}`)
  const parentRef = encRes.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }
  await putToNode(encRes)
  uploadedEncounters.add(encId)
}

// recursion para Observation.hasMember
async function uploadObservationWithMembers(obsId) {
  if (uploadedObservations.has(obsId)) return 0
  uploadedObservations.add(obsId)
  const obs = await getFromProxy(`/Observation/${obsId}`)
  let count = 1
  if (Array.isArray(obs.hasMember)) {
    for (const m of obs.hasMember) {
      if (m.reference?.startsWith('Observation/')) {
        count += await uploadObservationWithMembers(m.reference.split('/')[1])
      }
    }
  }
  await putToNode(obs)
  return count
}

async function uploadPractitioner(pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0
  const prac = await getFromProxy(`/Practitioner/${pracId}`)
  await putToNode(prac)
  uploadedPractitioners.add(pracId)
  return 1
}

// === Procedimientos (IPS) desde Observations OpenMRS ===
// Grupo (Procedure History) y componentes que muestras en tu JSON:
const PROC_GROUP_CODE = '160714AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' // Procedure History (grupo)
const PROC_CODES = {
  NAME_PERFORMED:  '1651AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Name of Procedure performed -> valueCodeableConcept
  PROC_DATE:       '160715AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Procedure date/time -> valueDateTime
  END_DATE:        '167132AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Procedure end date/time -> valueDateTime
  SITE_TEXT:       '163049AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Procedure site (text) -> valueString
  COMMENT:         '160716AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Procedure comment -> valueString
  DURATION:        '165929AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // Duration of procedure -> valueQuantity.value
  OUTCOME:         '160721AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'   // Procedure outcome -> valueCodeableConcept
}
const PROC_ALL_CODES = new Set([PROC_GROUP_CODE, ...Object.values(PROC_CODES)])
//const IPS_PROC_PROFILE = 'https://build.fhir.org/ig/HL7/fhir-ips/StructureDefinition-Procedure-uv-ips'
const IPS_PROC_PROFILE = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips'

function indexByIdFromBundle(bundle) {
  const map = {}
  for (const e of (bundle.entry || [])) {
    const r = e.resource
    if (r?.id) map[r.id] = r
  }
  return map
}
function codeList(r) {
  return (r?.code?.coding || []).map(c => c.code).filter(Boolean)
}
function pickMemberByCode(ids, byId, code) {
  for (const id of ids) {
    const r = byId[id]
    if (!r) continue
    if (codeList(r).includes(code)) return r
  }
  return undefined
}
function getEncounterFirstPractitioner(enc) {
  const x = (enc.participant || []).find(p => p.individual?.reference?.startsWith('Practitioner/'))
  return x?.individual?.reference
}
function getEncounterFirstLocation(enc) {
  const x = (enc.location || []).find(l => l.location?.reference?.startsWith('Location/'))
  return x?.location?.reference
}
/**
 * Construye un Procedure (perfil IPS) desde el grupo PROC_GROUP_CODE y sus hijas.
 * https://build.fhir.org/ig/HL7/fhir-ips/StructureDefinition-Procedure-uv-ips.html
 */
async function buildIPSProcedureFromGroup(groupObs, obsById, patientRef, enc) {
  const idList = (groupObs.hasMember || [])
    .map(m => m.reference?.replace(/^Observation\//,''))
    .filter(Boolean)

  // Hijas relevantes
  const nameObs  = pickMemberByCode(idList, obsById, PROC_CODES.NAME_PERFORMED)
  const startObs = pickMemberByCode(idList, obsById, PROC_CODES.PROC_DATE)
  const endObs   = pickMemberByCode(idList, obsById, PROC_CODES.END_DATE)
  const siteObs  = pickMemberByCode(idList, obsById, PROC_CODES.SITE_TEXT)
  const commObs  = pickMemberByCode(idList, obsById, PROC_CODES.COMMENT)
  const outObs   = pickMemberByCode(idList, obsById, PROC_CODES.OUTCOME)

  // status (obligatorio) – por defecto 'completed'
  const status = 'completed'

  // code (obligatorio) – desde "Name of Procedure performed"
  let code = nameObs?.valueCodeableConcept
  if (!code) code = { text: nameObs?.valueString || groupObs?.valueString || 'Unknown procedure' }

  // performed[x] – preferir Period si tenemos start y end; si no, DateTime
  const start = startObs?.valueDateTime
  const end   = endObs?.valueDateTime
  const performed =
    (start && end) ? { performedPeriod: { start, end } } :
    (start)        ? { performedDateTime: start } :
                     {}

  // bodySite – desde "Procedure site (text)"
  const bodySite = siteObs?.valueString ? [{ text: siteObs.valueString }] : undefined

  // outcome
  const outcome = outObs?.valueCodeableConcept

  // note – desde "Procedure comment"
  const note = commObs?.valueString ? [{ text: commObs.valueString }] : undefined

  // performer – primer Practitioner del Encounter
  const encounterRef = groupObs?.encounter?.reference || (enc?.id ? `Encounter/${enc.id}` : undefined)
  const locationRef = getEncounterFirstLocation(enc)
  const practitionerRef = getEncounterFirstPractitioner(enc)
  const performer = practitionerRef ? [{ actor: { reference: practitionerRef } }] : undefined

  // Construir Procedure IPS
  const proc = {
    resourceType: 'Procedure',
    id: groupObs.id, // usamos el id del grupo para trazabilidad
    meta: { profile: [IPS_PROC_PROFILE] },
    status,
    code,
    subject: { reference: patientRef }, // 1..1
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    ...performed,
    ...(locationRef ? { location: { reference: locationRef } } : {}),
    ...(performer ? { performer } : {}),
    ...(bodySite ? { bodySite } : {}),
    ...(outcome ? { outcome } : {}),
    ...(note ? { note } : {})
  }

  return proc
}

// Pipeline IPS Procedures por Encounter:
// - Busca SOLO el grupo PROC_GROUP_CODE del Encounter (include has-member)
// - Mapea a Procedure (perfil IPS)
async function processIPSProceduresByEncounter(encId, patientId, enc) {
  let sent = 0
  const url = `/Observation?encounter=Encounter/${encodeURIComponent(encId)}&code=${PROC_GROUP_CODE}&_include=Observation:has-member&_count=200&_format=application/fhir+json`
  const bundle = await getFromProxy(url)

  if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
    logStep('ⓘ No hay grupo Procedure History para encounter=', encId)
    return 0
  }

  const byId = indexByIdFromBundle(bundle)
  const patientRef = `Patient/${patientId}`
  const groups = bundle.entry
    .map(e => e.resource)
    .filter(r => r?.resourceType === 'Observation' && codeList(r).includes(PROC_GROUP_CODE))

  for (const g of groups) {
    const proc = await buildIPSProcedureFromGroup(g, byId, patientRef, enc)
    await putToNode(proc)
    sent++
  }
  return sent
}

// 6) Health endpoint del forwarder
app.get(['/forwarderProcedure/_health', '/forwarderprocedure/_health'], (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post(['/forwarderProcedure/_event', '/forwarderprocedure/_event'], async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  let sent = 0

  try {
    // 7.1) Fetch Encounter desde el proxy
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')

    // 7.3) Extraer patientId de enc.subject.reference
    const pid = enc.subject?.reference?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')

    // 7.4.1) Subir Patient
    const [, patientId ] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)
    normalizePatientIdentifiers(patient)
    await putToNode(patient)
    sent++

    // 7.4.2) Notificar al ITI-65 Mediator (best-effort)
    try {
      logStep('🔔 Notificando ITI-65 Mediator para', patientId)
      await axios.post(
        `${process.env.OPENHIM_SUMMARY_ENDPOINT}`,
        { uuid: patientId },
        { auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS }, httpsAgent: axios.defaults.httpsAgent }
      )
      logStep('✅ Mediator ITI-65 notificado')
    } catch (e) {
      console.error('❌ Error notificando ITI-65 Mediator:', e.response?.data || e.message)
    }

    // 7.5) Practitioners del Encounter
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          sent += await uploadPractitioner(indyRef)
        }
      }
    }

    // 7.5b) Locations del Encounter
    if (Array.isArray(enc.location)) {
      for (const locEntry of enc.location) {
        const locRef = locEntry.location?.reference
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1]
          await uploadLocationWithParents(locId)
          sent++
        }
      }
    }

    // 7.6) Subir Encounter (y padres)
    await uploadEncounterWithParents(uuid)
    sent++

    // 7.7) Recursos generales (excepto Observations Procedure History, ,'Condition','Procedure','MedicationRequest','Medication','AllergyIntolerance','DiagnosticReport')
    const types = ['Observation']
    for (const t of types) {
      let bundle
      try {
        bundle = await getFromProxy(`/${t}?patient=${encodeURIComponent(pid)}`)
        if (!bundle?.entry?.length) { logStep(`ⓘ ${t}: 0 resultados para patient=${pid}`); continue }
        logStep(`✓ ${t} by patient`)
      } catch (err) {
        logStep(`⚠️ Skip ${t} by patient: ${err?.message ?? err}`); continue
      }
      if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) continue

      for (const { resource } of bundle.entry) {
        // Saltar Observations Procedure History (grupo e hijas) — se convierten en Procedure IPS
        if (resource.resourceType === 'Observation') {
          const codes = codeList(resource)
          if (codes.some(c => PROC_ALL_CODES.has(c))) {
            logStep('↷ Skip Obs Procedure History (convertida a Procedure IPS):', resource.id)
            continue
          }
        }

        // Pre-subir Practitioners referenciados
        const pracRefs = [
          resource.recorder?.reference,
          resource.requester?.reference,
          ...(resource.performer||[]).map(p => p.actor?.reference)
        ].filter(r => r?.startsWith('Practitioner/'))
        for (const r of pracRefs) { sent += await uploadPractitioner(r) }

        // Limpiar ref a Practitioner no subido
        for (const field of ['recorder','requester']) {
          const ref = resource[field]?.reference
          if (ref?.startsWith('Practitioner/')) {
            const id = ref.split('/')[1]
            if (!uploadedPractitioners.has(id)) { logStep(`⚠️ Omitiendo ${field} no subido:`, id); delete resource[field] }
          }
        }
        if (Array.isArray(resource.performer)) {
          resource.performer = resource.performer.filter(p => {
            const ref = p.actor?.reference
            if (ref?.startsWith('Practitioner/')) {
              const perfId = ref.split('/')[1]
              if (!uploadedPractitioners.has(perfId)) { logStep('⚠️ Omitiendo performer no subido:', perfId); return false }
            }
            return true
          })
          if (resource.performer.length === 0) delete resource.performer
        }

        try {
          if (resource.resourceType === 'Observation') {
            // Subir otras Observations que no sean Procedure History (con recursividad hasMember)
            sent += await uploadObservationWithMembers(resource.id)
          } else {
            logStep('📤 Subiendo', resource.resourceType, resource.id)
            await putToNode(resource)
            sent++
          }
        } catch (e) {
          const diag = e.response?.data?.issue?.[0]?.diagnostics || ''
          if (diag.includes('Resource Practitioner/')) {
            try {
              logStep('⚠️ Retry sin referencias Practitioner tras error:', resource.id)
              delete resource.recorder
              delete resource.requester
              await putToNode(resource)
              sent++
            } catch (retryErr) { throw retryErr }
          } else { throw e }
        }
      }
    }

    // 7.7-bis) *** Procedure (IPS) desde Observations del Encounter ***
    sent += await processIPSProceduresByEncounter(uuid, pid, enc)

    // 7.8) Done
    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_PROCEDURE_PORT || 8015
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
