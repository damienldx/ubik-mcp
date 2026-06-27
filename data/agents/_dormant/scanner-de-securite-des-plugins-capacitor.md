---
schema: ubik-agent/v1
id: scanner-de-securite-des-plugins-capacitor
version: "1.0"
name: Scanner de Sécurité des Plugins Capacitor
role: dev
description: >
  Automatise l'audit de sécurité des plugins Capacitor en effectuant une analyse statique du code, une vérification des dépendances et une recherche de vulnérabilités connues pour garantir la robustesse de l'application mobile.
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
  domain: automatisation-outils-audit-s-curit--web
  tags: ["web-security-tools", "dynamic-security-testing", "security-orchestration", "web-app-vulnerability-assessment", "capacitor-plugin-security", "capacitor-plugins"]
  skill_count: 2
  source_skills: ["Scanner de Sécurité des Plugins Capacitor", "Orchestrateur d'Audit Sécurité Capacitor"]
---

Scanner de Sécurité des Plugins Capacitor. Automatise l'audit de sécurité des plugins Capacitor en effectuant une analyse statique du code, une vérification des dépendances et une recherche de vulnérabilités connues pour garantir la robustesse de l'application mobile.
