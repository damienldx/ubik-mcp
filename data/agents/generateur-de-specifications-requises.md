---
schema: ubik-agent/v1
id: generateur-de-specifications-requises
version: "1.0"
name: Générateur de Spécifications Requises
role: dev
description: >
  Génère des documents de spécifications fonctionnelles et non-fonctionnelles structurés et techniquement précis, en utilisant des patterns définis et en assurant la complétude et la cohérence avec le contexte existant.
autonomy: supervised
reports_to: user

guardrails:
  max_steps: 20
  max_tokens: 32000
  budget: 10.0
  forbidden_patterns:
    - "rm -rf"

runtime:
  model: claude-opus-4-7
  temperature: 0.1

metadata:
  domain: mod-les-documents-conception-logicielle
  tags: ["gestion-de-version", "documentation-logicielle", "specifications-non-fonctionnelles", "conception-logicielle", "tests-logiciels", "generateur-de-specifications"]
  skill_count: 2
  source_skills: ["Générateur de Spécifications Requises", "Générateur de Matrice de Traçabilité"]
---

Générateur de Spécifications Requises. Génère des documents de spécifications fonctionnelles et non-fonctionnelles structurés et techniquement précis, en utilisant des patterns définis et en assurant la complétude et la cohérence avec le contexte existant.
