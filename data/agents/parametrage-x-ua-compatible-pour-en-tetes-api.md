---
schema: ubik-agent/v1
id: parametrage-x-ua-compatible-pour-en-tetes-api
version: "1.0"
name: Paramétrage X-UA-Compatible pour En-têtes API
role: dev
description: >
  Configure l'en-tête `X-UA-Compatible` pour forcer le mode de rendu le plus récent d'Internet Explorer, améliorant la compatibilité et la sécurité des applications web en garantissant un comportement prévisible.
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
  domain: en-t-tes-de-s-curit--api
  tags: ["header-management", "xss-prevention", "permissions-policy", "http-headers", "attack-surface-reduction", "transport-layer-security"]
  skill_count: 17
  source_skills: ["Paramétrage X-UA-Compatible pour En-têtes API", "Protecteur X-Content-Type-Options pour En-têtes API", "Configureur Permissions-Policy pour En-têtes API", "Auditeur CSP pour En-têtes API", "Gestionnaire Cookies Sécurisés API"]
---

Paramétrage X-UA-Compatible pour En-têtes API. Configure l'en-tête `X-UA-Compatible` pour forcer le mode de rendu le plus récent d'Internet Explorer, améliorant la compatibilité et la sécurité des applications web en garantissant un comportement prévisible.
