// index.hcsba-org-only.seen.fix2.js
// FHIR Event Forwarder Mediator — SOLO default Organization (HCSBA) + seen.json
// Fixes: keep Encounter.location only if uploaded; strip missing Location on retry.
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
const devAgent = new https.Agent({ rejectUnauthorized: false })
if (process.env.NODE_ENV === 'development') {
  axios.defaults.httpsAgent = devAgent
  console.log('⚠️  DEV MODE: self-signed certs accepted')
}

// -------- Defaults (SOLO Organization) --------
const DEF_ORG_ENABLED = (process.env.DEFAULT_ORG_ENABLED || 'true').toLowerCase() === 'true'
const DEF_ORG_ID   = process.env.DEFAULT_ORG_ID   || 'hcsba'
const DEF_ORG_NAME = process.env.DEFAULT_ORG_NAME || 'Hospital Clínico San Borja Arriarán'
const DEF_ORG_RUT  = process.env.DEFAULT_ORG_RUT  || '61.608.604-9'
const DEF_ORG_URL  = process.env.DEFAULT_ORG_URL  || 'https://www.hcsba.cl/'
const DEF_ORG_PHONE= process.env.DEFAULT_ORG_PHONE|| '+56 2 25749000'
const DEF_ADDR_LINE= process.env.DEFAULT_ORG_ADDRESS_LINE || 'Avenida Santa Rosa 1234'
const DEF_ADDR_CITY= process.env.DEFAULT_ORG_CITY || 'Santiago'
const DEF_ADDR_DIST= process.env.DEFAULT_ORG_DISTRICT || 'Santiago Centro'
const DEF_ADDR_STATE=process.env.DEFAULT_ORG_STATE || 'Región Metropolitana'
const DEF_ADDR_COUNTRY=process.env.DEFAULT_ORG_COUNTRY || 'CL'

function buildDefaultOrganization(){
  return {
    resourceType: 'Organization',
    id: DEF_ORG_ID,
    active: true,
    name: DEF_ORG_NAME,
    alias: ['HCSBA','Hospital San Borja Arriarán'],
    identifier: [{
      use: 'official',
      type: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'TAX', display: 'Tax ID number' }],
        text: 'RUT'
      },
      system: 'https://www.superdesalud.gob.cl/registro',
      value: DEF_ORG_RUT
    }],
    telecom: [
      { system: 'phone', value: DEF_ORG_PHONE },
      { system: 'url', value: DEF_ORG_URL }
    ],
    address: [{
      use: 'work',
      type: 'physical',
      line: [DEF_ADDR_LINE],
      district: DEF_ADDR_DIST,
      city: DEF_ADDR_CITY,
      state: DEF_ADDR_STATE,
      country: DEF_ADDR_COUNTRY
    }]
  }
}

function logStep(msg, ...d) { console.log(new Date().toISOString(), msg, ...d) }

// 1) Register mediator & channels, then start heartbeat
registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err)
    process.exit(1)
  }
  console.log('✅ Forwarder registered')

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
        if (String(msg).includes('duplicate key error')) {
          console.log(`ℹ️ Channel already exists: ${ch.name}`)
        } else {
          console.error(`❌ Channel ${ch.name} error:`, msg)
        }
      })
    )
  ).then(() => {
    console.log('✅ All channels processed')
    activateHeartbeat(openhimConfig)
  })
})

const app = express()
app.use(express.json({ limit: '20mb' }))

// 2) seen.json: track last versionId per Encounter UUID
const SEEN_FILE = './seen.json'
let seenVersions = {}
try {
  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, '{}', 'utf8')
  const raw = fs.readFileSync(SEEN_FILE, 'utf8').trim()
  seenVersions = raw ? JSON.parse(raw) : {}
} catch (e) {
  console.warn('⚠️ Could not parse seen.json, re-initializing:', e.message)
  seenVersions = {}
  try { fs.writeFileSync(SEEN_FILE, '{}', 'utf8') } catch (err) {
    console.error('❌ Could not overwrite seen.json:', err)
  }
}
function saveSeen() {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seenVersions), 'utf8') }
  catch (err) { console.error('❌ Could not write seen.json:', err) }
}

// 3) Sources
const baseProxy = (process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')
async function getFromProxy(path) {
  const url = `${baseProxy}${path}`
  logStep('GET (proxy)', url)
  const resp = await axios.get(url, {
    validateStatus: false,
    auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS }
  })
  logStep('DEBUG proxy status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}

// Optional OpenMRS fallback (read-only) for Location/Encounter/Practitioner
const baseOMRS = (process.env.OPENMRS_FHIR_URL || '').replace(/\/$/, '')
const omrsAuth = process.env.OPENMRS_USER && process.env.OPENMRS_PASS
  ? { username: process.env.OPENMRS_USER, password: process.env.OPENMRS_PASS }
  : null
async function getFromOpenMRS(path) {
  if (!baseOMRS || !omrsAuth) throw new Error('OpenMRS fallback not configured')
  const url = `${baseOMRS}${path}`
  logStep('GET (openmrs)', url)
  const resp = await axios.get(url, {
    validateStatus:false,
    auth: omrsAuth,
    httpsAgent: axios.defaults.httpsAgent || devAgent,
    headers: { Accept: 'application/fhir+json' }
  })
  logStep('DEBUG openmrs status:', resp.status)
  if (resp.status >= 400) throw new Error(`${path} returned ${resp.status}`)
  return resp.data
}
function isGoneOrMissingError(err) {
  const m = String(err?.message || '').match(/ returned (\d{3})/)
  const code = m ? parseInt(m[1], 10) : undefined
  return code === 404 || code === 410
}

// helper: strip missing location from Encounter before retry
function stripEncounterLocation(resource, locId) {
  if (resource?.resourceType !== 'Encounter') return
  const ref = `Location/${locId}`
  const before = Array.isArray(resource.location) ? resource.location.length : 0
  if (Array.isArray(resource.location)) {
    resource.location = resource.location.filter(le => le?.location?.reference !== ref)
    if (resource.location.length === 0) delete resource.location
  }
  const after = Array.isArray(resource.location) ? resource.location.length : 0
  if (before !== after) logStep('🧹 Stripped missing Location from Encounter:', ref)
}

// 4) PUT destino con retry de dependencias
async function putToNode(resource) {
  const url = `${process.env.FHIR_NODE_URL}/fhir/${resource.resourceType}/${resource.id}`
  const doPut = async () => {
    logStep('PUT (node)', url)
    const r = await axios.put(url, resource, {
      headers:{ 'Content-Type':'application/fhir+json' },
      validateStatus: false
    })
    if (r.status >= 400) {
      logStep('❌ PUT failed payload:', JSON.stringify(r.data, null, 2))
      const diag = r?.data?.issue?.[0]?.diagnostics || ''
      const mEnc = typeof diag === 'string' ? diag.match(/Resource Encounter\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mLoc = typeof diag === 'string' ? diag.match(/Resource Location\/([A-Za-z0-9\-\.]{1,64})/) : null
      const mOrg = typeof diag === 'string' ? diag.match(/Resource Organization\/([A-Za-z0-9\-\.]{1,64})/) : null
      return { status: r.status, missingEncounterId: mEnc?.[1], missingLocationId: mLoc?.[1], missingOrganizationId: mOrg?.[1] }
    }
    logStep('✅ PUT OK', resource.resourceType, resource.id, r.status)
    return { status: r.status }
  }

  let res = await doPut()

  if (res.missingLocationId) {
    await uploadLocationWithParents(res.missingLocationId)
    // Si no logramos subir la Location, quita la referencia del Encounter antes del retry
    if (resource.resourceType === 'Encounter' && !uploadedLocations.has(res.missingLocationId)) {
      stripEncounterLocation(resource, res.missingLocationId)
    }
    res = await doPut()
  }
  if (res.missingOrganizationId) { await uploadOrganization(res.missingOrganizationId); res = await doPut() }
  if (res.missingEncounterId) { await uploadEncounterWithParents(res.missingEncounterId); res = await doPut() }
  if (res.status >= 400) throw new Error(`PUT failed ${res.status}`)
  return res.status
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

// 5) Caches
const uploadedLocations     = new Set()
const uploadedEncounters    = new Set()
const uploadedObservations  = new Set()
const uploadedPractitioners = new Set()
const uploadedOrganizations = new Set()

async function ensureDefaultOrganization(){
  if (!DEF_ORG_ENABLED) return
  if (!uploadedOrganizations.has(DEF_ORG_ID)) {
    const org = buildDefaultOrganization()
    logStep('🏥 Asegurando Organization por defecto…', DEF_ORG_ID)
    await putToNode(org)
    uploadedOrganizations.add(DEF_ORG_ID)
  }
}

async function uploadOrganization(orgId){
  if (uploadedOrganizations.has(orgId)) return 0
  try {
    logStep('🔍 Fetching Organization…', orgId)
    const org = await getFromProxy(`/Organization/${orgId}`)
    logStep('📤 Subiendo Organization…', orgId)
    await putToNode(org)
    uploadedOrganizations.add(orgId)
    return 1
  } catch (e) {
    if (DEF_ORG_ENABLED && (isGoneOrMissingError(e) || /Unknown resource type 'Organization'/.test(String(e)))) {
      await ensureDefaultOrganization()
      return 0
    }
    throw e
  }
}

async function uploadLocationWithParents(locId) {
  if (uploadedLocations.has(locId)) return;
  let loc
  try {
    logStep('🔍 Fetching Location…', locId);
    loc = await getFromProxy(`/Location/${locId}`);
  } catch (e) {
    if (isGoneOrMissingError(e) && baseOMRS && omrsAuth) {
      try { loc = await getFromOpenMRS(`/Location/${locId}`) }
      catch (e2) { if (isGoneOrMissingError(e2)) { logStep('🗑️  Location no disponible, se omite:', locId); return } else throw e2 }
    } else { if (isGoneOrMissingError(e)) { logStep('🗑️  Location no disponible, se omite:', locId); return } throw e }
  }
  const parentRef = loc.partOf?.reference;
  if (parentRef?.startsWith('Location/')) {
    const parentId = parentRef.split('/')[1];
    await uploadLocationWithParents(parentId);
  }
  logStep('📤 Subiendo Location…', locId);
  await putToNode(loc);
  uploadedLocations.add(locId);
}

async function uploadPractitioner(pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0 //deja en cache
  let prac
  try {
    logStep('🔍 Fetching Practitioner…', pracId)
    prac = await getFromProxy(`/Practitioner/${pracId}`)
  } catch (e) {
    if (isGoneOrMissingError(e) && baseOMRS && omrsAuth) {
      try { prac = await getFromOpenMRS(`/Practitioner/${pracId}`) }
      catch (e2) { if (isGoneOrMissingError(e2)) { logStep('🗑️  Practitioner no disponible, se omite:', pracId); return 0 } else throw e2 }
    } else { if (isGoneOrMissingError(e)) { logStep('🗑️  Practitioner no disponible, se omite:', pracId); return 0 } throw e }
  }
  logStep('📤 Subiendo Practitioner…', pracId)
  await putToNode(prac)
  uploadedPractitioners.add(pracId) //deja en cache
  return 1
}

async function uploadEncounterWithParents(encId) {
  if (uploadedEncounters.has(encId)) return
  let encRes
  try {
    logStep('🔍 Fetching Encounter…', encId)
    encRes = await getFromProxy(`/Encounter/${encId}`)
  } catch (e) {
    if (isGoneOrMissingError(e) && baseOMRS && omrsAuth) {
      try { encRes = await getFromOpenMRS(`/Encounter/${encId}`) }
      catch (e2) { if (isGoneOrMissingError(e2)) { logStep('🗑️  Encounter no disponible, se omite:', encId); return } else throw e2 }
    } else { throw e }
  }

  // padres
  const parentRef = encRes.partOf?.reference
  if (parentRef?.startsWith('Encounter/')) {
    const parentId = parentRef.split('/')[1]
    await uploadEncounterWithParents(parentId)
  }

  // serviceProvider
  const orgRef = encRes.serviceProvider?.reference
  if (orgRef?.startsWith('Organization/')) {
    try { await uploadOrganization(orgRef.split('/')[1]) }
    catch (e) {
      if (DEF_ORG_ENABLED && (isGoneOrMissingError(e) || /Unknown resource type 'Organization'/.test(String(e)))) {
        await ensureDefaultOrganization()
        encRes.serviceProvider = { reference: `Organization/${DEF_ORG_ID}` }
      } else throw e
    }
  } else if (DEF_ORG_ENABLED) {
    await ensureDefaultOrganization()
    encRes.serviceProvider = { reference: `Organization/${DEF_ORG_ID}` }
  }

  // locations (respetar reales; quitar inexistentes)
  if (Array.isArray(encRes.location)) {
    const filtered = []
    for (const locEntry of encRes.location) {
      const locRef = locEntry.location?.reference
      if (!locRef?.startsWith('Location/')) { filtered.push(locEntry); continue }
      const locId = locRef.split('/')[1]
      try {
        await uploadLocationWithParents(locId)
        // ✅ Solo conservar si efectivamente se subió
        if (uploadedLocations.has(locId)) filtered.push(locEntry)
        else logStep('🧹 Quitando Location no subida:', locId)
      } catch (e) {
        if (isGoneOrMissingError(e)) { logStep('🧹 Quitando Location inexistente:', locId) }
        else throw e
      }
    }
    encRes.location = filtered
    if (encRes.location.length === 0) delete encRes.location
  }

  // participants
  if (Array.isArray(encRes.participant)) {
    const filteredP = []
    for (const p of encRes.participant) {
      const indyRef = p.individual?.reference
      if (!indyRef?.startsWith('Practitioner/')) { filteredP.push(p); continue }
      try { await uploadPractitioner(indyRef); filteredP.push(p) }
      catch (e) { if (isGoneOrMissingError(e)) { logStep('🧹 Quitando participant inexistente:', indyRef) } else throw e }
    }
    encRes.participant = filteredP
    if (encRes.participant.length === 0) delete encRes.participant
  }

  logStep('📤 Subiendo Encounter…', encId)
  await putToNode(encRes)
  uploadedEncounters.add(encId)
}

// --- Observations ---
async function uploadObservationWithMembers(obsId) {
  if (uploadedObservations.has(obsId)) return 0
  uploadedObservations.add(obsId)

  const obs = await getFromProxy(`/Observation/${obsId}`)
  const encRef = obs?.encounter?.reference
  if (encRef?.startsWith('Encounter/')) {
    const encId = encRef.split('/')[1]
    await uploadEncounterWithParents(encId)
  }

  let count = 1
  if (Array.isArray(obs.hasMember)) {
    for (const m of obs.hasMember) {
      if (m.reference?.startsWith('Observation/')) {
        count += await uploadObservationWithMembers(m.reference.split('/')[1])
      }
    }
  }
  logStep('📤 Subiendo Observation…', obsId)
  await putToNode(obs)
  return count
}

// 6) Health
app.get('/forwarder/_health', (_req, res) => res.send('OK'))

// 7) Event endpoint
app.post('/forwarder/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  let sent = 0
  let encVersion = null

  try {
    const enc = await getFromProxy(`/Encounter/${uuid}`)
    if (!enc.resourceType) throw new Error('Invalid FHIR resource')

    // --- Duplicate check (by meta.versionId) no me funciona bien. ver despues, lo dejo comentado
    //encVersion = enc?.meta?.versionId || null
    //if (encVersion && seenVersions[uuid] === encVersion) {
    //  logStep('🔁 No version change, skipping', uuid, encVersion)
    //  return res.json({ status:'duplicate', uuid, version: encVersion })
    //}

    const pid = enc.subject?.reference?.split('/').pop()
    if (!pid) throw new Error('Encounter.subject.reference inválido')

    // Patient
    const [, patientId ] = enc.subject.reference.split('/')
    logStep('📤 Subiendo Patient…', patientId)
    const patient = await getFromProxy(`/Patient/${patientId}`)

    // Normalizar identificadores del Patient antes de subirlo
    normalizePatientIdentifiers(patient)

    await putToNode(patient); sent++

    // Notificar ITI-65
    try {
      logStep('🔔 Notificando ITI-65 Mediator para', patientId)
      await axios.post(
        `${process.env.OPENHIM_SUMMARY_ENDPOINT}`,
        { uuid: patientId },
        {
          auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
          httpsAgent: axios.defaults.httpsAgent || devAgent
        }
      )
      logStep('✅ Mediator ITI-65 notificado')
    } catch (e) {
      console.error('❌ Error notificando ITI-65 Mediator:', e.response?.data || e.message)
    }

    // Encounter (solo default Org; Location real u omitida)
    await uploadEncounterWithParents(uuid); sent++

    // Tipos por paciente (IPS-friendly) se elimina procedure, medicationrequest e inmunization porque lo resuelve sus respectivos mediadores
    const types = ['Observation','Condition','AllergyIntolerance','DiagnosticReport']

    for (const t of types) {
      let bundle;
      try {
        bundle = await getFromProxy(`/${t}?patient=${encodeURIComponent(pid)}`);
        if (!bundle?.entry?.length) { logStep(`ⓘ ${t}: 0 resultados para patient=${pid}`); continue; }
        logStep(`✓ ${t} by patient`);
      } catch (err) { logStep(`⚠️ Skip ${t} by patient:`, err?.message ?? err); continue; }

      if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) continue;

      for (const { resource } of bundle.entry) {
        const eRef = resource?.encounter?.reference
        if (eRef?.startsWith('Encounter/')) await uploadEncounterWithParents(eRef.split('/')[1])

        // Practitioners
        const pracRefs = [
          resource.recorder?.reference,
          resource.requester?.reference,
          ...(resource.performer||[]).map(p => p.actor?.reference)
        ].filter(r => r?.startsWith('Practitioner/'));
        for (const r of pracRefs) {
          try { await uploadPractitioner(r); sent++ }
          catch (e) { if (!isGoneOrMissingError(e)) throw e }
        }

        // limpiar recorder/requester si no quedaron
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
              const id = ref.split('/')[1]
              if (!uploadedPractitioners.has(id)) { logStep('⚠️ Omitiendo performer no subido:', id); return false }
            }
            return true
          })
          if (resource.performer.length === 0) delete resource.performer
        }

        if (resource.resourceType === 'Observation') { sent += await uploadObservationWithMembers(resource.id) }
        else { logStep('📤 Subiendo', resource.resourceType, resource.id); await putToNode(resource); sent++ }
      }
    }

    // --- Persist seen version AFTER successful processing
    //if (encVersion) {
    //  seenVersions[uuid] = encVersion
    //  saveSeen()
    //}

    logStep('🎉 Done', uuid)
    res.json({ status:'ok', uuid, version: encVersion || undefined, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.FORWARDER_MEDIATOR_PORT || 8003
app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT}`))
