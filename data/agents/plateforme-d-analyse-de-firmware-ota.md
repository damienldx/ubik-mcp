---
schema: ubik-agent/v1
id: plateforme-d-analyse-de-firmware-ota
version: "1.0"
name: Plateforme d'analyse de firmware OTA
role: dev
description: >
  Plateforme d'analyse de sécurité de firmware OTA, automatisant l'identification et la documentation des vulnérabilités par analyse statique, dynamique et recherche de menaces connues, fournissant des rapports exploitables en JSON.
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
  domain: impl-mentation-outils-s-curit--ota-firmw
  tags: ["dynamic-analysis-simulation", "iot-vulnerability-reporting", "security-assessment-automation", "ota-deployment-risk", "vulnerability-detection", "iot-firmware-auditing"]
  skill_count: 3
  source_skills: ["Plateforme d'analyse de firmware OTA", "Reporting d'analyse de firmware OTA", "Scanner de vulnérabilités de firmware OTA"]
---

Plateforme d'analyse de firmware OTA. Plateforme d'analyse de sécurité de firmware OTA, automatisant l'identification et la documentation des vulnérabilités par analyse statique, dynamique et recherche de menaces connues, fournissant des rapports exploitables en JSON.
