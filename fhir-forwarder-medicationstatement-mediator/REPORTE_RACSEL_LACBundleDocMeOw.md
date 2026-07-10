# Reporte a RACSEL — Desfase de versión en `LACBundleDocMeOw` (paquete del validador vs IG publicado)

**Perfil afectado:** `http://racsel.org/StructureDefinition/LACBundleDocMeOw|0.2`
**Componente:** Servicio de validación (Matchbox) del IG RACSEL LAC
**Fecha:** 2026-07-10
**Reportado por:** MINSAL Chile (conectathon Track 1.2)

## Resumen

El paquete `racsel.org#0.2` (build `2026-06-04`) que carga el **servicio de validación**
(Matchbox) contiene una definición de `LACBundleDocMeOw` **más antigua** que la publicada hoy
en el IG en línea (https://ig.racsel.org), que ya es **`0.2.1` (build `2026-07-03`)**. En la
versión que carga el validador, el slicing de `Bundle.entry` del documento **solo reconoce los
slices `Composition` y `Patient`**, y **no incluye el slice `MedicationStatement`** que **sí**
está definido en el IG publicado (0.2.1). Es decir: **el perfil ya fue corregido; el servicio
de validación quedó apuntando a la versión anterior.**

| | Versión | Build | Slice `MedicationStatement` |
|---|---|---|---|
| IG publicado (ig.racsel.org) | **0.2.1** | 2026-07-03 | ✅ presente |
| Paquete del validador (matchbox) | **0.2** | 2026-06-04 | ❌ ausente |

Como consecuencia, un documento MHD de resumen de medicamentos (donde la `Composition`
referencia obligatoriamente uno o más `MedicationStatement`) resulta **invalidable**: los
`MedicationStatement` que deben ir como entries del Bundle documento se marcan como
`NotSlice` contra un slicing cerrado.

## Evidencia

**Metadatos del validador (del reporte de validación):**

- `validatorVersion`: powered by matchbox 4.1.11, hapi-fhir 8.8.0 y org.hl7.fhir.core 6.9.11
- `package`: `racsel.org#0.2`
- `profileVersion`: `0.2`
- `profileDate`: `2026-06-04T11:27:18-03:00`

**Aserción emitida** (`Validation_VAL_Profile_NotSlice`, severidad ERROR) para el entry
`MedicationStatement` del Bundle documento (caso mínimo: **un** MedicationStatement):

> This element does not match any known slice defined in the profile
> `http://racsel.org/StructureDefinition/LACBundleDocMeOw|0.2` and slicing is CLOSED:
> Bundle.entry[2].resource.entry[2]: Does not match slice **'Composition'**
> (discriminator: resource.conformsTo('.../LACCompositionMeOw')), ...
> Does not match slice **'Patient'** (discriminator: resource.conformsTo('.../LACPatient'))

El mensaje **enumera únicamente los slices `Composition` y `Patient`** — no aparece ningún
slice `MedicationStatement`, lo que confirma que la StructureDefinition cargada por el
validador no lo define.

**Por qué la ausencia del slice es concluyente:** matchbox enumera *todos* los slices del
perfil al reportar `NotSlice`. En el mismo bundle, contra `LACBundleTransactionMHDMeOw|0.2`,
lista los **7** slices (SubmissionSet, DocumentRefs, UpdateDocumentRefs, Documents,
FhirDocuments, Folders, Patient). En el doc bundle lista **solo 2**. Si el slice
`MedicationStatement` existiera en el paquete cargado, aparecería en la enumeración (con match
o con su línea "Details for … matching against profile … LACMedicationStatementMeOw"). No
aparece → el slice no está definido en el paquete del validador. No es un problema de
conformidad del recurso `MedicationStatement`, sino la ausencia del slice.

**Reproducción (un solo MedicationStatement):** un `LACBundleTransactionMHDMeOw` por lo demás
correcto pasa de 11 errores a **2**, y ambos son la misma causa:
1. `Bundle.entry[2].resource.entry[2]` (MedicationStatement) → `NotSlice` (slice ausente).
2. `Bundle.entry[2]` (el Bundle documento) → `NotSlice` contra la slice `FhirDocuments` de la
   transacción, **en cascada** (el documento no puede conformar a `LACBundleDocMeOw` si su
   MedicationStatement no eslicea).
Con el fix del paquete, ambos deberían resolverse. El resto de slices ya conforma
(SubmissionSet/`LACList`, DocumentRefs/`LACDocReferenceMeOw`, Composition, Patient).

**En contraste, el IG publicado** (https://ig.racsel.org/StructureDefinition-LACBundleDocMeOw.html)
define el slicing de `Bundle.entry` como cerrado con **tres** slices:

| Slice | Perfil | Cardinalidad |
|-------|--------|--------------|
| Composition | `LACCompositionMeOw` | 1..1 |
| Patient | `LACPatient` | 1..1 |
| **MedicationStatement** | `LACMedicationStatementMeOw` | **1..\*** |

## Impacto

Un `LACBundleTransactionMHDMeOw` bien formado (Composition + Patient + MedicationStatement,
con la Organization autora *contenida* en la Composition) **falla** la validación contra el
paquete cacheado del validador, aun cuando cumple el IG publicado. Esto bloquea la evidencia
de conformidad del caso "Reporte de Medicamentos".

## Solicitud

1. **Apuntar el servicio de validación (Matchbox) al paquete `racsel.org#0.2.1`** (build
   2026-07-03), o refrescar su caché, para que `LACBundleDocMeOw` incluya el slice
   `MedicationStatement`. El perfil ya está corregido en el IG publicado; basta con que el
   validador cargue esa versión en lugar del `0.2` del 2026-06-04.
2. (Opcional) Confirmar qué versión debe usarse como referencia en el conectathon para evitar
   ambigüedad entre `0.2` y `0.2.1`.

## Nota secundaria (menor, severidad WARNING)

Independiente del desfase de versión: el display fijado por *pattern* en
`LACCompositionMeOw.type` y `LACDocReferenceMeOw.type` para LOINC `56445-0` es
`'Medication summary'`, pero el display oficial de LOINC para ese código es
`'Medication summary Document'`. Esto genera un WARNING de terminología
(`Display_Name_for__should_be_one_of__instead_of`) que es **inevitable**: respetar el pattern
(obligatorio) obliga a emitir un display que el TS marca como no oficial. Sugerencia: alinear
el pattern al display oficial de LOINC, o quitar el `display` del pattern (dejar solo
system+code). No bloquea la validación (solo warning), pero conviene resolverlo para dejar el
reporte limpio.

> Nota: el slice `Bundle.entry:SubmissionSet`/`LACList` que en una corrida previa aparecía como
> `NotSlice` **ya conforma** tras corregir el instance; era arrastre, no un problema del perfil.
