---
schema: ubik-agent/v1
id: tableau-de-bord-accessibilite-aria
version: "1.0"
name: Tableau de Bord Accessibilité ARIA
role: dev
description: >
  Génère un rapport d'audit d'accessibilité ARIA complet, incluant un score de conformité, l'identification des problèmes d'implémentation ARIA, et des recommandations de correction techniques et actionnables pour améliorer l'expérience utilisateur des technologies d'assistance.
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
  domain: tests-d-accessibilit--attributs-aria
  tags: ["semantic-analysis", "web-development", "browser-extension-development", "javascript-accessibility", "aria-accessibility-audit", "aria-semantics"]
  skill_count: 21
  source_skills: ["Tableau de Bord Accessibilité ARIA", "Identificateur de Lacunes Sémantiques ARIA", "Vérificateur Internationalisation ARIA", "Audit Contenu Dynamique ARIA", "Validation CLI ARIA"]
---

Tableau de Bord Accessibilité ARIA. Génère un rapport d'audit d'accessibilité ARIA complet, incluant un score de conformité, l'identification des problèmes d'implémentation ARIA, et des recommandations de correction techniques et actionnables pour améliorer l'expérience utilisateur des technologies d'assistance.
