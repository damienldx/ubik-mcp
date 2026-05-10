---
schema: ubik-agent/v1
id: analyseur-concurrents-lp
version: "1.0"
name: Analyseur Concurrents LP
role: dev
description: >
  Analyse approfondie des landing pages concurrentes pour identifier les stratégies de conversion, les points de friction et les opportunités de différenciation, générant des recommandations actionnables pour l'optimisation.
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
  domain: cr-ation-landing-pages-marketing
  tags: ["redaction-web", "analyse-concurrentielle-avancée", "copywriting-persuasif", "appel-a-l-action", "taux-de-clic", "design-ui-ux"]
  skill_count: 3
  source_skills: ["Analyseur Concurrents LP", "Optimiseur CTA Landing Page", "Rédacteur IA Landing Page"]
---

Analyseur Concurrents LP. Analyse approfondie des landing pages concurrentes pour identifier les stratégies de conversion, les points de friction et les opportunités de différenciation, générant des recommandations actionnables pour l'optimisation.
