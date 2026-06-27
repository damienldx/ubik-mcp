---
schema: ubik-agent/v1
id: analyseur-d-ombre-de-texte
version: "1.0"
name: Analyseur d'Ombre de Texte
role: dev
description: >
  Analyse l'impact des ombres de texte sur le contraste et la lisibilité, en calculant les ratios de contraste selon les normes WCAG et en fournissant des recommandations techniques pour optimiser l'accessibilité.
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
  domain: contraste-des-couleurs-accessible
  tags: ["front-end-accessibility", "wcag-3.x", "contraste-couleur", "rapport-contraste", "verification-contraste", "analyse-contraste-degrade"]
  skill_count: 8
  source_skills: ["Analyseur d'Ombre de Texte", "Sélecteur de Niveau WCAG", "Application du Contraste Minimum Textuel", "Générateur de Couleur de Fond Accessible", "Calculateur de Ratio de Contraste"]
---

Analyseur d'Ombre de Texte. Analyse l'impact des ombres de texte sur le contraste et la lisibilité, en calculant les ratios de contraste selon les normes WCAG et en fournissant des recommandations techniques pour optimiser l'accessibilité.
