# Reporte a RACSEL — Desfase de versión en `LACBundleDocMeOw` (paquete del validador vs IG publicado)

**Perfil afectado:** `http://racsel.org/StructureDefinition/LACBundleDocMeOw|0.2`
**Componente:** Servicio de validación (Matchbox) del IG RACSEL LAC
**Fecha:** 2026-07-10
**Reportado por:** MINSAL Chile (conectathon Track 1.2)

## Resumen

El paquete `racsel.org#0.2` que carga el **servicio de validación** (Matchbox) contiene una
definición de `LACBundleDocMeOw` **más antigua** que la publicada en el IG en línea
(https://ig.racsel.org). En la versión que carga el validador, el slicing de `Bundle.entry`
del documento **solo reconoce los slices `Composition` y `Patient`**, y **no incluye el slice
`MedicationStatement`** que sí está definido en el IG publicado.

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

**Aserción emitida** (`Validation_VAL_Profile_NotSlice`, severidad ERROR) para cada entry
`MedicationStatement` del Bundle documento:

> This element does not match any known slice defined in the profile
> `http://racsel.org/StructureDefinition/LACBundleDocMeOw|0.2` and slicing is CLOSED:
> Bundle.entry[2].resource.entry[3]: Does not match slice **'Composition'**
> (discriminator: resource.conformsTo('.../LACCompositionMeOw')), ...
> Does not match slice **'Patient'** (discriminator: resource.conformsTo('.../LACPatient'))

El mensaje **enumera únicamente los slices `Composition` y `Patient`** — no aparece ningún
slice `MedicationStatement`, lo que confirma que la StructureDefinition cargada por el
validador no lo define.

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

1. **Actualizar/republicar el paquete `racsel.org#0.2`** que carga el servicio de validación
   para que `LACBundleDocMeOw` incluya el slice `MedicationStatement` (alinear con el IG en línea), **o**
2. Publicar una versión con número distinto (p. ej. `0.2.x`/`0.3`) e indicar cuál debe usarse
   en el conectathon, para evitar dos definiciones distintas bajo la misma etiqueta `0.2`.

## Nota adicional (para verificación cruzada)

Menor y probablemente relacionado con el mismo desfase: convendría confirmar que el slice
`Bundle.entry:SubmissionSet` de `LACBundleTransactionMHDMeOw|0.2` en el paquete del validador
está alineado con `LACList` del IG (un `List`/SubmissionSet conforme al IG publicado también
se estaba marcando como `NotSlice`, sin sub-aserción propia que indique la causa).
