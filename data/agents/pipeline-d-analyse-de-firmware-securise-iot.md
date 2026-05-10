---
schema: ubik-agent/v1
id: pipeline-d-analyse-de-firmware-securise-iot
version: "1.0"
name: Pipeline d'Analyse de Firmware Sécurisé IoT
role: dev
description: >
  Orchestre un pipeline d'analyse de sécurité automatisé pour le firmware IoT, intégrant des analyses statiques, dynamiques et de fuzzing pour identifier et rapporter les vulnérabilités de manière exhaustive.
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
  domain: s-curit--des-appareils-iot
  tags: ["embedded-systems-security", "cybersecurity-operations", "firmware-tampering-detection", "static-analysis-security-testing", "security-pipeline-orchestration", "bootloader-configuration-analysis"]
  skill_count: 2
  source_skills: ["Pipeline d'Analyse de Firmware Sécurisé IoT", "Enforceur de Démarrage Sécurisé IoT"]
---

Pipeline d'Analyse de Firmware Sécurisé IoT. Orchestre un pipeline d'analyse de sécurité automatisé pour le firmware IoT, intégrant des analyses statiques, dynamiques et de fuzzing pour identifier et rapporter les vulnérabilités de manière exhaustive.
