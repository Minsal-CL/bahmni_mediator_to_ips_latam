// index.js (FHIR Event Forwarder Mediator) — Vacunación -> Immunization (ICVP & LAC modes)
import 'dotenv/config'
import express from 'express'
import axios from 'axios'
import https from 'https'
import fs from 'fs'
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils'
//import mediatorConfig from './mediatorConfig.json' with { type: 'json' }
import mediatorConfig from './mediatorConfig.json' assert { type: 'json' }


// --- OpenHIM config ---
const openhimConfig = {
  username: process.env.OPENHIM_USER,
  password: process.env.OPENHIM_PASS,
  apiURL: (process.env.OPENHIM_API || '').replace(/\/$/, ''),
  trustSelfSigned: true
}

// HTTPS agent (allow self-signed)
axios.defaults.httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  cert: process.env.CLIENT_CERT && fs.existsSync(process.env.CLIENT_CERT) ? fs.readFileSync(process.env.CLIENT_CERT) : undefined,
  key: process.env.CLIENT_KEY && fs.existsSync(process.env.CLIENT_KEY) ? fs.readFileSync(process.env.CLIENT_KEY) : undefined
})

// =============================
// Helpers: logging & utils
// =============================
function logStep (...args) { console.log(new Date().toISOString(), '-', ...args) }
const DEBUG_VAX = /^true$/i.test(process.env.DEBUG_VAX || 'false')
const DEBUG_TRANSLATE = /^true$/i.test(process.env.DEBUG_TRANSLATE || 'false')
function dbgV (...a) { if (DEBUG_VAX) logStep('[DEBUG_VAX]', ...a) }
function dbgT (...a) { if (DEBUG_TRANSLATE) logStep('[DEBUG_XLATE]', ...a) }

function codeList (obs) { return (obs?.code?.coding || []).map(c => c.code).filter(Boolean) }
function indexByIdFromBundle (bundle) { const byId = new Map(); for (const e of (bundle.entry || [])) if (e.resource?.id) byId.set(e.resource.id, e.resource); return byId }
function pickMemberByCode (idList, byId, code) { return idList.map(id => byId.get(id)).find(r => codeList(r).includes(code)) }
function toDate (dt) { return (typeof dt === 'string' ? dt.substring(0, 10) : undefined) }

// =============================
// ICVP / LAC constants & flags
// =============================
const IMM_MODE = (process.env.IMM_MODE || 'ICVP').toUpperCase() // 'ICVP' | 'LAC'

// ICVP
const ICVP_IMM_PROFILE = 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP'
const ICVP_DOSE_NUM_CC_EXT = 'http://smart.who.int/icvp/StructureDefinition/doseNumberCodeableConcept'
const IHE_MCSD_PRACTITIONER = 'https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.Practitioner'
const IHE_MCSD_JURISDICTION_ORG = 'https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.JurisdictionOrganization'
const ICVP_STRICT = /^true$/i.test(process.env.ICVP_STRICT || 'true')

// LAC PASS
const LAC_IMM_PROFILE = 'http://lacpass.racsel.org/StructureDefinition/lac-immunization'
const LAC_ORG_PROFILE = 'http://racsel.org/StructureDefinition/LACOrganization'
const EXT_LAC_BRAND      = 'http://lacpass.racsel.org/StructureDefinition/DDCCEventBrand'
const EXT_LAC_MA         = 'http://lacpass.racsel.org/StructureDefinition/DDCCVaccineMarketAuthorization'
const EXT_LAC_COUNTRY    = 'http://lacpass.racsel.org/StructureDefinition/DDCCCountryOfEvent'
const EXT_LAC_VALID_FROM = 'http://lacpass.racsel.org/StructureDefinition/DDCCVaccineValidFrom'

// =============================
// Translate-only flags & constants (NO lookup / NO validate)
// =============================
const TERMINOLOGY_BASE = (process.env.TERMINOLOGY_BASE || '').replace(/\/$/, '')
const USE_CONCEPTMAP_TRANSLATE = /^true$/i.test(process.env.USE_CONCEPTMAP_TRANSLATE || process.env.TRANSLATE_VACCINE || 'true')

// Targets
const ICD11_TARGET_SYSTEM = process.env.ICD11_TARGET_SYSTEM || 'http://id.who.int/icd/release/11/mms'
const PREQUAL_TARGET_SYSTEM = process.env.PREQUAL_TARGET_SYSTEM || 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs'

// Optional: force source system for ConceptMap $translate
//const CM_TRANSLATE_SOURCE_SYSTEM = process.env.CM_TRANSLATE_SOURCE_SYSTEM || ''
// FORCE: use this source system for all $translate calls, always
const CM_TRANSLATE_SOURCE_SYSTEM = 'http://node-acme.org/terminology'

// Extensión ICVP ProductID
const EXT_ICVP_PRODUCT_ID = 'http://smart.who.int/icvp/StructureDefinition/ProductID'

// --- Parse $translate Parameters
function parseTranslate(parameters) {
  const params = parameters?.parameter || []
  const matches = params.filter(p => p.name === 'match')
  for (const m of matches) {
    const parts = m.part || []
    const eq = parts.find(p => p.name === 'equivalence')?.valueCode
    const concept = parts.find(p => p.name === 'concept')?.valueCoding
    const code = concept?.code || parts.find(p => p.name === 'code')?.valueCode
    const system = concept?.system || parts.find(p => p.name === 'system')?.valueUri
    const display = concept?.display || parts.find(p => p.name === 'display')?.valueString
    if (code && system && (!eq || eq === 'equivalent' || eq === 'wider' || eq === 'narrower')) {
      return { system, code, ...(display ? { display } : {}) }
    }
  }
  return null
}

// --- Call $translate (GET then POST fallback). No lookup/validate aquí.
async function conceptMapTranslate({ system, code, targetSystem }) {
  if (!USE_CONCEPTMAP_TRANSLATE || !TERMINOLOGY_BASE || !system || !code || !targetSystem) return null
  const base = TERMINOLOGY_BASE.replace(/\/$/, '')
  // GET
  try {
    const url = `${base}/ConceptMap/$translate`
    dbgT('GET', url, 'params:', { system, code, targetsystem: targetSystem })
    const { data } = await axios.get(url, {
      params: { code, system, targetsystem: targetSystem },
      httpsAgent: axios.defaults.httpsAgent
    })
    dbgT('GET translate resp:', JSON.stringify(data))
    const out = parseTranslate(data)
    if (out) return out
  } catch (e) {
    dbgT('GET translate error:', e.message)
  }
  // POST
  try {
    const url = `${base}/ConceptMap/$translate`
    const body = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'code', valueCode: code },
        { name: 'system', valueUri: system },
        { name: 'targetsystem', valueUri: targetSystem }
      ]
    }
    dbgT('POST', url, 'body:', JSON.stringify(body))
    const { data } = await axios.post(url, body, { httpsAgent: axios.defaults.httpsAgent })
    dbgT('POST translate resp:', JSON.stringify(data))
    return parseTranslate(data)
  } catch (e) {
    dbgT('POST translate error:', e.message)
    return null
  }
}

// =============================
// FHIR Proxy / Node helpers
// =============================
async function getFromProxy (path) {
  const url = `${(process.env.FHIR_PROXY_URL || '').replace(/\/$/, '')}${path}`
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

async function putToNode (resource) {
  const base = (process.env.FHIR_NODE_URL || '').replace(/\/$/, '')
  const url = `${base}/fhir/${resource.resourceType}/${resource.id}`
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
// Cache for uploaded resources
// =============================
const uploadedPractitioners = new Set()
const uploadedOrganizations = new Set()
const uploadedLocations = new Set()

async function ensureOrganizationByName (name) {
  if (!name) return undefined
  const id = ('org-' + String(name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''))
  if (uploadedOrganizations.has(id)) return { reference: `Organization/${id}`, display: name }
  const org = {
    resourceType: 'Organization',
    id,
    meta: { profile: [IMM_MODE === 'ICVP' ? IHE_MCSD_JURISDICTION_ORG : LAC_ORG_PROFILE] },
    name: String(name),
    address: [{ use: 'work', country: (process.env.LAC_COUNTRY_CODE || 'CL').toUpperCase() }]
  }
  await putToNode(org)
  uploadedOrganizations.add(id)
  return { reference: `Organization/${id}`, display: org.name }
}

async function uploadPractitioner (pracRef) {
  const pracId = pracRef.split('/')[1]
  if (uploadedPractitioners.has(pracId)) return 0
  const prac = await getFromProxy(`/Practitioner/${pracId}`)
  if (IMM_MODE === 'ICVP') {
    prac.meta = prac.meta || {}
    const profiles = new Set(prac.meta.profile || [])
    profiles.add(IHE_MCSD_PRACTITIONER)
    prac.meta.profile = Array.from(profiles)
  }
  await putToNode(prac)
  uploadedPractitioners.add(pracId)
  return 1
}

async function uploadLocationWithParents (locId) {
  if (uploadedLocations.has(locId)) return 0
  const loc = await getFromProxy(`/Location/${locId}`)
  await putToNode(loc)
  uploadedLocations.add(locId)
  const orgRef = loc.managingOrganization?.reference
  if (orgRef?.startsWith('Organization/')) {
    const orgId = orgRef.split('/')[1]
    if (!uploadedOrganizations.has(orgId)) {
      const org = await getFromProxy(`/Organization/${orgId}`)
      if (IMM_MODE === 'ICVP') {
        org.meta = org.meta || {}
        org.meta.profile = [IHE_MCSD_JURISDICTION_ORG]
      }
      await putToNode(org)
      uploadedOrganizations.add(orgId)
    }
  }
  return 1
}

function getEncounterFirstPractitioner (enc) {
  const x = (enc?.participant || []).find(p => p.individual?.reference?.includes('Practitioner/'))
  return x?.individual?.reference
}
function getEncounterFirstLocation(enc) {
  // Busca la primera location con referencia al recurso Location
  const x = (enc?.location || []).find(
    l => l.location?.reference?.includes('Location/')
  )

  if (x?.location?.reference) {
    // Retorna el objeto completo, con reference y display
    const locDisplay =
      process.env.LAC_DEFAULT_LOCATION_DISPLAY ||
      process.env.ICVP_DEFAULT_LOCATION_DISPLAY ||
      'Administration center'
    const locationObj = {
      reference: x.location.reference,
      display: x.location.display || locDisplay
    }
    console.log('FOUND LOC REF:', locationObj)
    return locationObj
  }

  // Si no hay referencia válida, retorna el objeto con display por defecto
  const defaultLoc = {
    display:
      process.env.LAC_DEFAULT_LOCATION_DISPLAY ||
      process.env.ICVP_DEFAULT_LOCATION_DISPLAY ||
      'Administration center'
  }
  console.log('NO LOC FOUND, USING DEFAULT:', defaultLoc)
  return defaultLoc
}

// =============================
// LAC extras
// =============================
function buildLacImmunizationExtensions () {
  const ext = []
  if (!process.env.LAC_BRAND_SYSTEM || !process.env.LAC_BRAND_CODE) {
    throw new Error('Faltan LAC_BRAND_SYSTEM o LAC_BRAND_CODE para DDCCEventBrand')
  }
  ext.push({ url: EXT_LAC_BRAND, valueCoding: { system: process.env.LAC_BRAND_SYSTEM, code: process.env.LAC_BRAND_CODE } })
  ext.push({ url: EXT_LAC_COUNTRY, valueCode: (process.env.LAC_COUNTRY_CODE || 'CL').toUpperCase() })
  if (process.env.LAC_MA_SYSTEM && process.env.LAC_MA_CODE) {
    ext.push({ url: EXT_LAC_MA, valueCoding: { system: process.env.LAC_MA_SYSTEM, code: process.env.LAC_MA_CODE } })
  }
  if (process.env.LAC_VALID_FROM) {
    ext.push({ url: EXT_LAC_VALID_FROM, valueDate: process.env.LAC_VALID_FROM })
  }
  return ext
}

// =============================
// Source codes (OpenMRS concept UUIDs)
// =============================
// Set: Vaccination Event (grupo de Observations)
const IMM_SET_CODE = '1421AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// Códigos base (deja un default para VACCINE; otros entran por ENV)
const IMM_CODES = {
  // Vaccination -> valueCodeableConcept
  VACCINE:       'fd324375-d937-4225-82a8-c1c76b6d80a3', // tu UUID local por defecto
  VAX_DATE:      '1410AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  LOT:           '1420AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  LOT_EXP:       '165907AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  MANUFACTURER:  '1419AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  DOSE_NUM:      '1418AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  NON_CODED:     '166011AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  RECEIVED:      '163100AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  YES:           '1065AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  NO:            '1066AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
}

// Posibles códigos del miembro "vacuna" (ENV + fallbacks conocidos)
const VACCINE_MEMBER_CODES = new Set(
  (process.env.VACCINE_MEMBER_CODES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    // Fallbacks: estándar OpenMRS + tu local por defecto
    .concat(['984AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', IMM_CODES.VACCINE])
)

// Set maestro con TODOS los códigos relevantes
const IMM_ALL_CODES = new Set([
  ...Object.values(IMM_CODES),
  IMM_SET_CODE,
  ...VACCINE_MEMBER_CODES
])



function isRelevantVaccinationObservation (r) {
  return r?.resourceType === 'Observation' && codeList(r).some(c => IMM_ALL_CODES.has(c))
}

// =============================
// Builder: Immunization from group
// =============================
async function buildImmunizationFromGroup (groupObs, obsById, patientRef, enc, patientId) {
  const idList = (groupObs.hasMember || [])
    .map(m => m.reference?.replace(/^Observation\//, ''))
    .filter(Boolean)

  //const vaxObs   = pickMemberByCode(idList, obsById, IMM_CODES.VACCINE)
  const vaxObs   = idList
    .map(id => obsById.get(id))
    .find(r => r && codeList(r).some(c => VACCINE_MEMBER_CODES.has(c)))
  const freeObs  = pickMemberByCode(idList, obsById, IMM_CODES.NON_CODED)
  const dateObs  = pickMemberByCode(idList, obsById, IMM_CODES.VAX_DATE)
  const lotObs   = pickMemberByCode(idList, obsById, IMM_CODES.LOT)
  const expObs   = pickMemberByCode(idList, obsById, IMM_CODES.LOT_EXP)
  const mfgObs   = pickMemberByCode(idList, obsById, IMM_CODES.MANUFACTURER)
  const doseObs  = pickMemberByCode(idList, obsById, IMM_CODES.DOSE_NUM)
  const recvObs  = pickMemberByCode(idList, obsById, IMM_CODES.RECEIVED)

  if (DEBUG_VAX) {
  const membersDbg = idList.map(id => {
    const r = obsById.get(id)
    return {
      id,
      codes: codeList(r),
      valueString: r?.valueString,
      valueCC: r?.valueCodeableConcept?.coding
    }
  })
  dbgV('members in group', JSON.stringify(membersDbg))
}

  // status (completed | entered-in-error | not-done)
  let status = 'completed'
  const recvCoding = recvObs?.valueCodeableConcept?.coding || []
  if (recvCoding.find(c => c.code === IMM_CODES.NO)) status = 'not-done'
  if (recvCoding.find(c => c.code === IMM_CODES.YES)) status = 'completed'

  // vaccineCode (código local) — tolerar system faltante y varios orígenes del code
  let localCoding = null

  // 1) coding.code (aunque sin system)
  //const anyCoding = vaxObs?.valueCodeableConcept?.coding?.find(c => c && c.code) || null
  //if (anyCoding?.code) {
  //  const sys = anyCoding.system || CM_TRANSLATE_SOURCE_SYSTEM || null
  //  if (sys) {
  //    localCoding = { system: sys, code: String(anyCoding.code), ...(anyCoding.display ? { display: anyCoding.display } : {}) }
  //  }
  //}

  const anyCoding = vaxObs?.valueCodeableConcept?.coding?.find(c => c && c.code) || null
  if (anyCoding?.code) {
    // FORCE system: ignore incoming system
    localCoding = {
      system: CM_TRANSLATE_SOURCE_SYSTEM,
      code: String(anyCoding.code),
      ...(anyCoding.display ? { display: anyCoding.display } : {})
    }
  }


  // 2) valueString
  if (!localCoding && vaxObs?.valueString && CM_TRANSLATE_SOURCE_SYSTEM) {
    const codeStr = String(vaxObs.valueString).trim()
    if (codeStr) localCoding = { system: CM_TRANSLATE_SOURCE_SYSTEM, code: codeStr }
  }

  // 3) valueCodeableConcept.text
  if (!localCoding && vaxObs?.valueCodeableConcept?.text && CM_TRANSLATE_SOURCE_SYSTEM) {
    const codeStr = String(vaxObs.valueCodeableConcept.text).trim()
    if (codeStr) localCoding = { system: CM_TRANSLATE_SOURCE_SYSTEM, code: codeStr }
  }

  // 4) freeObs.valueString (si parece id)
  if (!localCoding && freeObs?.valueString && CM_TRANSLATE_SOURCE_SYSTEM) {
    const raw = String(freeObs.valueString).trim()
    if (/^[a-z0-9-]{6,}$/i.test(raw)) {
      localCoding = { system: CM_TRANSLATE_SOURCE_SYSTEM, code: raw }
    }
  }

  if (!localCoding) {
    dbgV('vaxObs payload:', JSON.stringify({
      codeCoding: vaxObs?.code?.coding,
      valueCC: vaxObs?.valueCodeableConcept,
      valueString: vaxObs?.valueString
    }))
    throw new Error('No se pudo determinar vaccineCode (código local); revisa valueCodeableConcept.coding|text, valueString, o freeObs.valueString')
  }

  // Source system del translate (ENV o el del código local)
  //const sourceSystem = CM_TRANSLATE_SOURCE_SYSTEM || localCoding.system

  // FORCE: always use the forced source system
  const sourceSystem = CM_TRANSLATE_SOURCE_SYSTEM

  // $translate → ICD-11 (OBLIGATORIO)
  const icd11Coding = await conceptMapTranslate({
    system: sourceSystem,
    code: localCoding.code,
    targetSystem: ICD11_TARGET_SYSTEM
  })
  if (!icd11Coding) {
    throw new Error(`No se pudo traducir a ICD-11 (system=${sourceSystem}, code=${localCoding.code})`)
  }

  // $translate → PreQual (OBLIGATORIO para extensión ProductID)
  const prequalCoding = await conceptMapTranslate({
    system: sourceSystem,
    code: localCoding.code,
    targetSystem: PREQUAL_TARGET_SYSTEM
  })
  if (!prequalCoding) {
    throw new Error(`No se pudo traducir a PreQual ProductIDs (system=${sourceSystem}, code=${localCoding.code})`)
  }

  dbgT('ICD11 result:', icd11Coding, 'PreQual result:', prequalCoding)

  // vaccineCode.coding: SOLO ICD-11 (sin display para cumplir con el perfil)
  const vaccineCodeCoding = {
    system: icd11Coding.system || ICD11_TARGET_SYSTEM,
    code: icd11Coding.code
  }
  const vaccineCodeText = prequalCoding?.display || icd11Coding.display

  // occurrenceDateTime
  const occurrenceDateTime = dateObs?.valueDateTime || groupObs?.effectiveDateTime
  if (!occurrenceDateTime) throw new Error('Falta occurrenceDateTime para Immunization')

  // encounter + location
  const encounterRef = groupObs?.encounter?.reference || (enc?.id ? `Encounter/${enc.id}` : undefined)
  const location = getEncounterFirstLocation(enc)
  // const locDisplay = (process.env.LAC_DEFAULT_LOCATION_DISPLAY || process.env.ICVP_DEFAULT_LOCATION_DISPLAY || 'Administration center')
  // const location = locationRef ? { reference: locationRef, display: locDisplay } : { display: locDisplay }

  // manufacturer
  const manufacturerRef = await ensureOrganizationByName(mfgObs?.valueString)

  // performer
  const practitionerRef = getEncounterFirstPractitioner(enc)
  let performer = practitionerRef ? [{ actor: { reference: practitionerRef } }] : []
  if (IMM_MODE === 'ICVP' && performer.length === 0) {
    const perfOrg = await ensureOrganizationByName(process.env.ICVP_PERFORMER_ORG_NAME || process.env.ICVP_AUTHORITY_ORG_NAME)
    if (perfOrg) performer.push({ actor: perfOrg })
  }
  if (performer.length === 0) performer = undefined

  // protocolApplied (dose)
  let doseNumber
  const dn = doseObs?.valueQuantity?.value
  if (Number.isFinite(dn)) doseNumber = Math.trunc(dn)
  else if (doseObs?.valueString && /^\d+$/.test(doseObs.valueString)) doseNumber = parseInt(doseObs.valueString, 10)
  else if (process.env.LAC_DEFAULT_DOSE_NUMBER) doseNumber = parseInt(process.env.LAC_DEFAULT_DOSE_NUMBER, 10)
  if (!doseNumber) throw new Error('Falta doseNumberPositiveInt en protocolApplied')

  let protocolApplied
  if (IMM_MODE === 'ICVP') {
    const pae = {
      doseNumberPositiveInt: doseNumber,
      extension: [{ url: ICVP_DOSE_NUM_CC_EXT, valueCodeableConcept: { text: `Dose ${doseNumber}` } }]
    }
    const authRef = await ensureOrganizationByName(process.env.ICVP_AUTHORITY_ORG_NAME || process.env.LAC_AUTHORITY_ORG_NAME)
    if (!authRef) {
      if (ICVP_STRICT) throw new Error('ICVP requiere protocolApplied.authority (configura ICVP_AUTHORITY_ORG_NAME)')
    } else {
      pae.authority = authRef
    }
    if (process.env.ICVP_TD_SYSTEM && process.env.ICVP_TD_CODE) {
      pae.targetDisease = [{ coding: [{ system: process.env.ICVP_TD_SYSTEM, code: process.env.ICVP_TD_CODE }] }]
    }
    protocolApplied = [pae]
  } else {
    const pae = { doseNumberPositiveInt: doseNumber }
    if (process.env.LAC_AUTHORITY_ORG_NAME) pae.authority = await ensureOrganizationByName(process.env.LAC_AUTHORITY_ORG_NAME)
    if (process.env.LAC_TD_SYSTEM && process.env.LAC_TD_CODE) {
      pae.targetDisease = [{ coding: [{ system: process.env.LAC_TD_SYSTEM, code: process.env.LAC_TD_CODE }] }]
    }
    protocolApplied = [pae]
  }

  // lot / expiration
  const lotNumber = lotObs?.valueString
  const expirationDate = toDate(expObs?.valueDateTime)

  const profile = (IMM_MODE === 'ICVP') ? ICVP_IMM_PROFILE : LAC_IMM_PROFILE

  // Extensión ICVP ProductID con PreQual
  const icvpProductIdExt = prequalCoding ? [{
    url: EXT_ICVP_PRODUCT_ID,
    valueCoding: {
      system: PREQUAL_TARGET_SYSTEM,
      code: prequalCoding.code
    }
  }] : []

  const baseExt = (IMM_MODE === 'LAC') ? buildLacImmunizationExtensions() : []
  const allExtensions = (IMM_MODE === 'ICVP') ? icvpProductIdExt : baseExt

  const imm = {
    resourceType: 'Immunization',
    id: groupObs.id, // trazabilidad
    meta: { profile: [profile] },
    ...(allExtensions.length ? { extension: allExtensions } : {}),
    status,
    vaccineCode: {
      coding: [vaccineCodeCoding],
      ...(vaccineCodeText ? { text: vaccineCodeText } : {})
    },
    patient: { reference: patientRef },
    ...(encounterRef ? { encounter: { reference: encounterRef } } : {}),
    occurrenceDateTime,
    ...(location ? { location } : {}),
    ...(manufacturerRef ? { manufacturer: manufacturerRef } : {}),
    ...(lotNumber ? { lotNumber } : {}),
    ...(expirationDate ? { expirationDate } : {}),
    ...(performer ? { performer } : {}),
    protocolApplied
  }

  return imm
}

// =============================
// Pipeline: build Immunizations for patient
// =============================
async function processImmunizationsByPatient (patientId, enc) {
  let sent = 0
  const url = `/Observation?patient=${encodeURIComponent(patientId)}&code=${IMM_SET_CODE}&_include=Observation:has-member&_count=200&_format=application/fhir+json`
  const bundle = await getFromProxy(url)

  if (bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
    logStep('ⓘ No hay grupos de vacunación (1421) para', patientId)
    return 0
  }

  const byId = indexByIdFromBundle(bundle)
  const patientRef = `Patient/${patientId}`
  const groups = bundle.entry
    .map(e => e.resource)
    .filter(r => r?.resourceType === 'Observation' && codeList(r).includes(IMM_SET_CODE))

  for (const g of groups) {
    const imm = await buildImmunizationFromGroup(g, byId, patientRef, enc, patientId)
    await putToNode(imm)
    sent++
  }
  return sent
}

// =============================
// NEW: Safe getters + encounter resolver for event uuid
// =============================
async function getIfExists (path) {
  try {
    return await getFromProxy(path)
  } catch (e) {
    if (String(e.message).endsWith(' returned 404')) return null
    throw e
  }
}

async function resolveEncounterAndPatient (uuid) {
  // 1) Treat as Encounter ID
  const enc1 = await getIfExists(`/Encounter/${encodeURIComponent(uuid)}`)
  if (enc1?.resourceType === 'Encounter') {
    const pid = enc1.subject?.reference?.split('/')[1]
    return { enc: enc1, pid }
  }

  // 2) Treat as Composition ID → follow encounter
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

  // 3) Legacy fallback: persisted Bundle containing an Encounter
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
// Express app
// =============================
const app = express()
app.use(express.json({ limit: '2mb' }))

// Health path from mediatorConfig (fallback retained)
const HEALTH_PATH = mediatorConfig.heartbeatPath || '/forwarderimmunization/_health'
app.get(HEALTH_PATH, (_req, res) => res.status(200).json({ status: 'ok', mediator: process.env.MEDIATOR_URN || mediatorConfig.urn }))

app.post('/forwarderimmunization/_event', async (req, res) => {
  logStep('📩 POST /event', req.body)
  const { uuid } = req.body
  if (!uuid) return res.status(400).json({ error: 'Missing uuid' })

  try {
    // Resolve Encounter + patient from event uuid
    const { enc, pid } = await resolveEncounterAndPatient(uuid)
    if (!enc) return res.status(404).json({ error: `No se encontró Encounter para uuid=${uuid}` })
    if (!pid) return res.status(404).json({ error: `Encounter sin patient (uuid=${uuid})` })

    // Upload Encounter-linked actors
    if (Array.isArray(enc.participant)) {
      for (const p of enc.participant) {
        const indyRef = p.individual?.reference
        if (indyRef?.startsWith('Practitioner/')) {
          await uploadPractitioner(indyRef)
        }
      }
    }
    if (Array.isArray(enc.location)) {
      for (const locEntry of enc.location) {
        const locRef = locEntry.location?.reference
        if (locRef?.startsWith('Location/')) {
          const locId = locRef.split('/')[1]
          await uploadLocationWithParents(locId)
        }
      }
    }

    // Subir Patient (asegura $summary disponible en el nodo)
    try {
      logStep('📤 Subiendo Patient…', pid)
      const patient = await getFromProxy(`/Patient/${pid}`)
      normalizePatientIdentifiers(patient)
      await putToNode(patient)
    } catch (e) {
      logStep('⚠️ No se pudo subir Patient:', e.message)
    }

    // Vaccination → Immunization (ICVP/LAC)
    const sent = await processImmunizationsByPatient(pid, enc)

    // Notificar ITI-65 ICVP (vía OpenHIM)
    try {
      const immMode = (process.env.IMM_MODE || 'ICVP').toUpperCase()
      const endpoint = process.env.OPENHIM_ICVP_ENDPOINT || process.env.OPENHIM_SUMMARY_ENDPOINT
      if (immMode === 'ICVP' && endpoint) {
        logStep('🔔 Notificando ITI-65 ICVP para', pid)
        await axios.post(
          endpoint,
          { uuid: pid },
          {
            auth: { username: process.env.OPENHIM_USER, password: process.env.OPENHIM_PASS },
            httpsAgent: axios.defaults.httpsAgent
          }
        )
        logStep('✅ Mediator ITI-65 ICVP notificado')
      } else if (immMode === 'ICVP') {
        logStep('ⓘ OPENHIM_ICVP_ENDPOINT/OPENHIM_SUMMARY_ENDPOINT no configurado; se omite notificación')
      }
    } catch (e) {
      console.error('❌ Error notificando ITI-65 ICVP:', e.response?.data || e.message)
    }

    logStep('🎉 Done', uuid)
    return res.json({ status: 'ok', uuid, sent })
  } catch (e) {
    logStep('❌ ERROR:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// --- Mediator registration (RESPECT mediatorConfig) ---
const openhimOptions = {
  apiURL: openhimConfig.apiURL,
  username: openhimConfig.username,
  password: openhimConfig.password,
  trustSelfSigned: openhimConfig.trustSelfSigned,
  urn: process.env.MEDIATOR_URN || mediatorConfig.urn
}
const me = mediatorConfig

function onRegister (err) {
  if (err) return logStep('❌ Registration failed', err)
  logStep('✅ Registered mediator', openhimOptions.urn)
  activateHeartbeat(openhimOptions, me.heartbeatInterval || 30000)
}

registerMediator(openhimOptions, me, onRegister)

const PORT = process.env.FORWARDER_IMMUNIZATION_PORT || 8009
const appServer = app.listen(PORT, () => logStep(`FHIR Forwarder on port ${PORT} (health at ${HEALTH_PATH})`))

export default appServer
