---
description: "Security review of the changes (exploitability-focused, OWASP)"
---
SECURITY-REVIEW the current diff (Claude /security-review style):
1. Analyze the changed code for exploitable vulnerabilities: injection (SQL/XSS/command), auth/authz bypass, path traversal, SSRF, secrets in code/logs, unsafe deserialization, CSRF.
2. Rate by ACTUAL exploitability, not severity theory: what would an attacker need to trigger it, what's the impact.
3. For each finding: file:line, exploit path, fix suggestion. Fix confirmed issues directly (own commits); report the rest.
4. Security has priority: never ship a known exploitable issue, even if it means blocking the work.
