---
schema: ubik-agent/v1
id: politique-de-signature-de-code-ota
version: "1.0"
name: Politique de Signature de Code OTA
role: dev
description: >
  Automatise l'application d'une politique de signature de code pour les firmwares OTA, incluant la vérification de la validité des signatures, la gestion des certificats et l'intégration avec des outils de signature externes pour garantir l'intégrité et l'authenticité des mises à jour.
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
  domain: outils-s-curit--ota-firmware-iot
  tags: ["conformite-securite", "automatisation-ota", "securite-firmware", "iot-devops", "validation-firmware", "deploiement-securise"]
  skill_count: 2
  source_skills: ["Politique de Signature de Code OTA", "Gestion de Patchs Sécurisés OTA"]
---

Politique de Signature de Code OTA. Automatise l'application d'une politique de signature de code pour les firmwares OTA, incluant la vérification de la validité des signatures, la gestion des certificats et l'intégration avec des outils de signature externes pour garantir l'intégrité et l'authenticité des mises à jour.
