# FHIR Event Forwarder — Contrarreferencia (respuesta a Interconsulta)

Toma el Encounter del formulario **Contrarreferencia** (una observación de texto = *Resultado de la
Evaluación*) y arma el **documento MHD** de respuesta a una Interconsulta Transfronteriza, conforme al
IG RACSEL. Lo POSTea como **transacción ITI-65** al **nodo nacional** y lo enlaza (best-effort) al
`ServiceRequest` activo del paciente.

## Flujo (Track 1.2 — vuelta / país B)

```
Encounter con obs 931c9e9c-…  (form Contrarreferencia)
   → narrativa = section[55112-7].text  (title "Resultado de la Evaluación")
   → type=11488-4 (Consultation note), status=final, author=Organización destino, subject=paciente
   → resuelve el ServiceRequest activo del paciente en el NN (patient.identifier)
        → Composition.event.detail + DocumentReference.context.related → ServiceRequest
   → Composition (LACCompositionIT) → Bundle documento (LACBundleDocIT)
        → DocumentReference (LACDocReferenceIT, type 11488-4) → List (LACList)
        → Bundle transacción (LACBundleTransactionMHDIT)
   → POST ITI-65 al nodo nacional  + copia en MHD_DUMP_DIR + orquestación en OpenHIM
```

## Perfiles IG (variante IT)

- `LACCompositionIT` — nota de interconsulta (LOINC 11488-4), sección única 55112-7 "Resultado de la Evaluación".
- `LACBundleDocIT`, `LACDocReferenceIT`, `LACList`, `LACBundleTransactionMHDIT`, `LACOrganization`.

## Alcance / decisiones

- **Un solo servidor FHIR**: el nodo **nacional** (`CR_MHD_ENDPOINT`), tanto para el POST del documento
  como para resolver el `ServiceRequest`.
- **Enlace de vuelta best-effort**: si no se encuentra un `ServiceRequest` activo, el documento igual se
  emite (el IG lo correlaciona por `patient.identifier`). El enlace duro (`context.related`) es un extra
  no-conflictivo que desambigua múltiples ciclos por paciente.
- **Un ciclo por paciente por vez**: el IG no soporta múltiples interconsultas/respuestas concurrentes
  por paciente de forma no ambigua (linkage por `patient.identifier`).

## Ejecutar

```bash
npm install && npm start          # puerto 8020
```

## Variables (.env)

Ver el bloque `# Forwarder Contrarreferencia Mediator` en el `.env` de la raíz. Clave de disparo:
`CR_CONCEPT_EVAL` (concepto Text del form Contrarreferencia).
