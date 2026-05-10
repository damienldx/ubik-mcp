---
schema: ubik-agent/v1
id: popuper-d-intention-de-sortie-landing-page
version: "1.0"
name: Popuper d'Intention de Sortie Landing Page
role: dev
description: >
  Automatise la création et l'intégration de popups d'intention de sortie dynamiques, optimisés pour la capture de leads et la maximisation des conversions de dernière minute sur les landing pages, en utilisant des scripts JavaScript, HTML et CSS.
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
  domain: impl-mentation-automatisation-outils-opt
  tags: ["feature-flagging", "cta-optimization", "ab-testing-deployment", "user-flow-visualization", "a-b-testing", "conversion-funnel-mapping"]
  skill_count: 14
  source_skills: ["Popuper d'Intention de Sortie Landing Page", "Télémètre de Profondeur de Scroll Landing Page", "Optimiseur UX Landing Page", "Optimiseur de Layout Landing Page", "Mapper de Tunnel de Conversion Landing Page"]
---

Popuper d'Intention de Sortie Landing Page. Automatise la création et l'intégration de popups d'intention de sortie dynamiques, optimisés pour la capture de leads et la maximisation des conversions de dernière minute sur les landing pages, en utilisant des scripts JavaScript, HTML et CSS.
