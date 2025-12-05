# Security Audit Roadmap

Comprehensive security audit for Obsidian Local REST API plugin. This roadmap documents security vulnerabilities, remediation priorities, and improvement opportunities based on OWASP, MITRE ATT&CK, and CWE frameworks.

**Audit Date:** December 2024
**Plugin Version:** 3.2.0
**Auditor:** Claude Code Security Analysis

## Status Legend

| Status | Description |
|--------|-------------|
| `idea` | Under consideration |
| `planned` | Accepted, not started |
| `in-progress` | Actively being worked on |
| `done` | Completed |

## Executive Summary

The Obsidian Local REST API plugin provides a REST interface to Obsidian vaults. While designed for local-only use, several security concerns exist that could impact users in various threat scenarios. Key risk areas include:

- **Critical:** Vulnerable dependencies (node-forge, form-data)
- **High:** Unrestricted command execution, path traversal potential, plaintext credential storage
- **Medium:** No rate limiting, global CORS, excessive request size limits
- **Low:** Information disclosure, logging gaps

---

## P0 - Critical Security Issues

Issues requiring immediate attention due to active exploitation risk or critical impact.

| Item | Status | OWASP | CWE | Impact | Effort | Details |
|------|--------|-------|-----|--------|--------|---------|
| Upgrade node-forge to latest | `planned` | A06:2021 | CWE-1395 | Critical | Small | Current v1.2.1 has 3 high/critical vulnerabilities: ASN.1 unbounded recursion (GHSA-554w-wpv2-vw27), interpretation conflict (GHSA-5gfm-wpxj-wjgq), OID integer truncation (GHSA-65ch-62r8-g69g) |
| Fix form-data critical vulnerability | `planned` | A06:2021 | CWE-330 | Critical | Small | Uses unsafe random function for boundary selection (GHSA-fjxv-7rqg-78g4) - indirect dependency via jsdom |
| Implement path traversal protection | `planned` | A01:2021 | CWE-22 | High | Medium | No validation against `../` sequences in vault paths. See `requestHandler.ts:343`. Should use `path.resolve()` with vault root boundary enforcement |
| Restrict command execution | `planned` | A01:2021 | CWE-78 | High | Medium | Any authenticated user can execute ANY Obsidian command via `/commands/:commandId/`. See `requestHandler.ts:965-985`. Add allowlist/blocklist mechanism |

## P1 - High Priority Security Issues

Significant security weaknesses that should be addressed in near-term releases.

| Item | Status | OWASP | CWE | Impact | Effort | Details |
|------|--------|-------|-----|--------|--------|---------|
| Secure credential storage | `planned` | A02:2021 | CWE-312 | High | Medium | API key and TLS private key stored in plaintext in `data.json`. Use platform credential managers (Keychain, Credential Manager, Secret Service) |
| Add rate limiting | `planned` | A04:2021 | CWE-770 | High | Medium | No rate limiting on any endpoints. Enables brute-force attacks on API key and resource exhaustion. Implement token bucket algorithm |
| Restrict CORS origins | `planned` | A01:2021 | CWE-346 | High | Small | Global CORS enabled with no origin restrictions (`cors()` with no options at `requestHandler.ts:1221`). Any website can make authenticated requests if API key is compromised. Add configurable origin allowlist |
| Reduce request size limit | `planned` | A05:2021 | CWE-400 | High | Small | 1024MB limit in `constants.ts:64` enables resource exhaustion attacks. Reduce to reasonable size (10-50MB) with per-endpoint limits |
| Fix on-headers vulnerability | `planned` | A06:2021 | CWE-113 | High | Small | response-time depends on vulnerable on-headers <1.1.0 allowing HTTP response header manipulation (GHSA-76c9-3jph-rj3q) |

## P2 - Medium Priority Security Issues

Security improvements that enhance defense-in-depth.

| Item | Status | OWASP | CWE | Impact | Effort | Details |
|------|--------|-------|-----|--------|--------|---------|
| Add input validation layer | `planned` | A03:2021 | CWE-20 | Medium | Medium | Create centralized input validation for search queries, file paths, template parameters. Limit string lengths, sanitize special characters |
| Protect regex operations | `planned` | A03:2021 | CWE-1333 | Medium | Small | User-controlled regex patterns in JSONLogic `regexp` operation (`requestHandler.ts:99-107`) can cause ReDoS. Add complexity limits and timeout |
| Implement request signing | `planned` | A07:2021 | CWE-345 | Medium | Medium | Add HMAC request signing between plugin and MCP server to prevent request tampering |
| Add security headers | `planned` | A05:2021 | CWE-693 | Medium | Small | Missing security headers: CSP, X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security |
| Sanitize log output | `planned` | A09:2021 | CWE-532 | Medium | Small | Console logging at `requestHandler.ts:1214` may expose sensitive data. Add PII/secret redaction |
| Secure certificate handling | `planned` | A02:2021 | CWE-295 | Medium | Medium | Self-signed certs enable MITM on first connection. Consider certificate pinning for known clients, TOFU model |
| Audit jsonLogic operations | `planned` | A03:2021 | CWE-94 | Medium | Medium | Custom JSONLogic operations `glob` and `regexp` (`requestHandler.ts:88-107`) need security review for injection risks |
| Fix brace-expansion ReDoS | `planned` | A06:2021 | CWE-1333 | Medium | Small | Multiple instances of vulnerable brace-expansion (GHSA-v6h2-p8h4-qcjw) in dev dependencies |
| Fix js-yaml prototype pollution | `planned` | A06:2021 | CWE-1321 | Medium | Small | js-yaml <4.1.1 has prototype pollution in merge (GHSA-mh29-5h37-fv8m) |
| Upgrade esbuild | `planned` | A06:2021 | CWE-352 | Medium | Small | esbuild <=0.24.2 allows any website to send requests to dev server (GHSA-67mh-4wv8-2f99) |

## P3 - Low Priority Security Issues

Minor issues or defense-in-depth improvements.

| Item | Status | OWASP | CWE | Impact | Effort | Details |
|------|--------|-------|-----|--------|--------|---------|
| Reduce information disclosure | `planned` | A01:2021 | CWE-200 | Low | Small | Root endpoint exposes versions, manifest, certificate info without auth. OpenAPI spec reveals all endpoints. Consider auth-gating sensitive info |
| Add constant-time comparison | `planned` | A07:2021 | CWE-208 | Low | Small | API key comparison at `requestHandler.ts:145` may be vulnerable to timing attacks. Use `crypto.timingSafeEqual()` |
| Implement audit logging | `planned` | A09:2021 | CWE-778 | Low | Medium | No structured audit trail for security-relevant events. Add JSON logging with timestamps, user context, request IDs |
| Add API key rotation | `planned` | A02:2021 | CWE-324 | Low | Small | No automatic key rotation mechanism. Add scheduled rotation reminders or automatic rotation |
| Secure error messages | `planned` | A05:2021 | CWE-209 | Low | Small | Error handler at `requestHandler.ts:1186-1208` may expose internal details. Sanitize error messages in production |
| Document security model | `idea` | - | - | Low | Small | Create SECURITY.md documenting threat model, security boundaries, and reporting procedures |

---

## OWASP Top 10 (2021) Coverage

Summary of how each OWASP category applies to this codebase.

### A01:2021 - Broken Access Control

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| No path traversal validation | High | `planned` | `requestHandler.ts:343-347` |
| Unrestricted command execution | High | `planned` | `requestHandler.ts:965-985` |
| Global CORS policy | High | `planned` | `requestHandler.ts:1221` |
| Binary auth model (no RBAC) | Medium | `idea` | `requestHandler.ts:141-150` |
| Unauthenticated endpoints expose info | Low | `planned` | `requestHandler.ts:157-161` |

### A02:2021 - Cryptographic Failures

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| Plaintext credential storage | High | `planned` | `main.ts:44-51, 138-143` |
| Self-signed certificates (MITM risk) | Medium | `planned` | `main.ts:52-144` |
| No key rotation mechanism | Low | `planned` | Settings UI only |
| RSA 2048-bit (adequate but consider 4096) | Info | `idea` | `main.ts:57` |

### A03:2021 - Injection

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| JSONLogic evaluation of user input | Medium | `planned` | `requestHandler.ts:1092-1113` |
| Dataview DQL query execution | Medium | `idea` | `requestHandler.ts:1061-1091` |
| User-controlled regex patterns | Medium | `planned` | `requestHandler.ts:99-107` |
| Glob pattern handling | Low | `idea` | `requestHandler.ts:88-97` |

### A04:2021 - Insecure Design

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| No rate limiting | High | `planned` | All endpoints |
| HTTP option available | Medium | `idea` | `main.ts:205-217` |
| Excessive request size (1024MB) | Medium | `planned` | `constants.ts:64` |
| No request timeout configuration | Low | `idea` | Server setup |

### A05:2021 - Security Misconfiguration

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| Exposed API documentation without auth | Low | `planned` | `requestHandler.ts:157-161` |
| Missing security headers | Medium | `planned` | Express app config |
| Verbose error messages | Low | `planned` | `requestHandler.ts:1186-1208` |
| Advanced settings expose dangerous options | Low | `idea` | `main.ts:508-668` |

### A06:2021 - Vulnerable and Outdated Components

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| node-forge vulnerabilities (3 high) | Critical | `planned` | `package.json:51` |
| form-data critical vulnerability | Critical | `planned` | Indirect dependency |
| on-headers header manipulation | High | `planned` | Via response-time |
| esbuild dev server vulnerability | Medium | `planned` | `package.json:33` |
| brace-expansion ReDoS | Medium | `planned` | Multiple locations |
| js-yaml prototype pollution | Medium | `planned` | Via istanbul |
| svelte XSS (via obsidian-dataview) | Medium | `idea` | Indirect dependency |

### A07:2021 - Identification and Authentication Failures

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| No rate limiting on auth attempts | High | `planned` | `requestHandler.ts:152-174` |
| Timing-vulnerable comparison | Low | `planned` | `requestHandler.ts:145` |
| No MFA/2FA support | Info | `idea` | Architecture |

### A08:2021 - Software and Data Integrity Failures

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| No request integrity verification | Medium | `planned` | All endpoints |
| Plugin auto-update without verification | Low | `idea` | Obsidian plugin system |

### A09:2021 - Security Logging and Monitoring Failures

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| Basic console logging only | Medium | `planned` | `requestHandler.ts:1214` |
| No structured audit trail | Low | `planned` | Logging system |
| Error stack traces logged | Low | `planned` | `requestHandler.ts:1192-1196` |
| No alerting mechanism | Low | `idea` | Infrastructure |

### A10:2021 - Server-Side Request Forgery (SSRF)

| Finding | Severity | Status | Location |
|---------|----------|--------|----------|
| No SSRF concerns identified | - | N/A | No outbound HTTP requests in core |

---

## MITRE ATT&CK Mapping

Relevant techniques that could be used against this application.

### Initial Access

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Exploit Public-Facing Application | T1190 | High - if exposed to network | Localhost binding default, add binding host warnings |
| Valid Accounts | T1078 | Medium - API key compromise | `planned` - add key rotation, secure storage |

### Execution

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Command and Scripting Interpreter | T1059 | High - command execution API | `planned` - add command allowlist |
| Exploitation for Client Execution | T1203 | Medium - via vulnerable deps | `planned` - dependency updates |

### Persistence

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Account Manipulation | T1098 | Low - single API key model | `idea` - add key management |

### Credential Access

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Unsecured Credentials | T1552 | High - plaintext in data.json | `planned` - secure credential storage |
| Brute Force | T1110 | Medium - no rate limiting | `planned` - add rate limiting |
| Credentials in Files | T1552.001 | High - data.json contains key | `planned` - encrypt at rest |

### Discovery

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| File and Directory Discovery | T1083 | Medium - vault listing API | `idea` - add access logging |
| System Information Discovery | T1082 | Low - version info exposed | `planned` - auth-gate info |

### Collection

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Data from Local System | T1005 | High - full vault access | Inherent to design |
| Automated Collection | T1119 | Medium - search/list APIs | `idea` - add rate limiting per endpoint |

### Exfiltration

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Exfiltration Over Web Service | T1567 | Medium - if compromised | Inherent to REST API |
| Automated Exfiltration | T1020 | Medium - via search APIs | `idea` - add data volume monitoring |

### Impact

| Technique | ID | Applicability | Mitigation Status |
|-----------|----|---------------|-------------------|
| Data Destruction | T1485 | High - DELETE endpoint | `idea` - add soft-delete option |
| Data Manipulation | T1565 | High - PUT/PATCH endpoints | `idea` - add change auditing |

---

## CWE Vulnerability Coverage

Common Weakness Enumeration mapping for identified issues.

### Input Validation

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-20 | Improper Input Validation | Medium | `planned` | No centralized input validation |
| CWE-22 | Path Traversal | High | `planned` | No `../` prevention in vault paths |
| CWE-78 | OS Command Injection | High | `planned` | Unrestricted command execution |
| CWE-94 | Code Injection | Medium | `planned` | JSONLogic evaluation risks |
| CWE-1333 | ReDoS | Medium | `planned` | User-controlled regex patterns |

### Authentication & Authorization

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-208 | Timing Attack | Low | `planned` | Non-constant-time comparison |
| CWE-306 | Missing Authentication | Low | `planned` | Endpoints expose info without auth |
| CWE-324 | Use of Key Past Expiration | Low | `planned` | No key rotation mechanism |
| CWE-345 | Insufficient Verification | Medium | `planned` | No request signing |
| CWE-346 | Origin Validation Error | High | `planned` | Global CORS policy |

### Cryptography

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-295 | Improper Certificate Validation | Medium | `planned` | Self-signed cert MITM risk |
| CWE-312 | Cleartext Storage | High | `planned` | Plaintext secrets in data.json |
| CWE-330 | Insufficient Randomness | Critical | `planned` | form-data dependency |

### Resource Management

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-400 | Resource Exhaustion | High | `planned` | 1024MB request limit |
| CWE-770 | Resource Allocation Without Limits | High | `planned` | No rate limiting |

### Error Handling & Logging

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-200 | Information Exposure | Low | `planned` | Version/config disclosure |
| CWE-209 | Error Message Information Exposure | Low | `planned` | Detailed error messages |
| CWE-532 | Log File Information Exposure | Medium | `planned` | Potential secret logging |
| CWE-778 | Insufficient Logging | Low | `planned` | No audit trail |

### Third-Party Components

| CWE | Name | Severity | Status | Details |
|-----|------|----------|--------|---------|
| CWE-1321 | Prototype Pollution | Medium | `planned` | js-yaml vulnerability |
| CWE-1395 | Dependency Vulnerabilities | Critical | `planned` | node-forge, form-data |

---

## Remediation Roadmap

Suggested implementation order based on risk and effort.

### Phase 1: Critical Fixes (Immediate)

1. **Update vulnerable dependencies**
   - Upgrade node-forge to latest stable
   - Run `npm audit fix` for automatic fixes
   - Manually address breaking changes for remaining issues

2. **Add path traversal protection**
   ```typescript
   // Example fix in requestHandler.ts
   function validateVaultPath(requestedPath: string, vaultRoot: string): boolean {
     const resolved = path.resolve(vaultRoot, requestedPath);
     return resolved.startsWith(vaultRoot) && !requestedPath.includes('..');
   }
   ```

3. **Implement command allowlist**
   - Add `allowedCommands` setting
   - Default to safe commands only
   - Log blocked command attempts

### Phase 2: High Priority (Next Release)

1. **Add rate limiting**
   - Use express-rate-limit package
   - Configure per-endpoint limits
   - Add authentication attempt throttling

2. **Restrict CORS**
   - Add `allowedOrigins` setting
   - Default to localhost only
   - Document cross-origin requirements

3. **Reduce request limits**
   - Lower to 50MB default
   - Add per-endpoint configuration
   - Document size requirements

### Phase 3: Security Hardening (Following Releases)

1. **Secure credential storage**
   - Integrate keytar for cross-platform credential storage
   - Migrate existing plaintext credentials
   - Add secure deletion of old data

2. **Add security headers and logging**
   - Implement helmet.js for security headers
   - Add structured JSON logging
   - Create audit event types

3. **Implement request signing**
   - Add HMAC signing for API extension requests
   - Document signing implementation for clients

---

## Testing Requirements

Security-focused testing needed for remediation verification.

| Test Category | Coverage Goal | Tools |
|---------------|---------------|-------|
| Dependency Scanning | 100% deps | npm audit, Snyk |
| Path Traversal | All file endpoints | Manual + fuzzing |
| Authentication | All auth flows | Jest + supertest |
| Rate Limiting | All endpoints | Load testing |
| Input Validation | All user inputs | Fuzzing + manual |
| CORS | Origin restrictions | Browser testing |
| Logging | Security events | Log analysis |

---

## References

### Security Standards
- [OWASP Top 10 (2021)](https://owasp.org/Top10/)
- [MITRE ATT&CK](https://attack.mitre.org/)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/)

### Vulnerability Databases
- [GitHub Security Advisories](https://github.com/advisories)
- [npm Audit](https://docs.npmjs.com/cli/v8/commands/npm-audit)
- [NVD](https://nvd.nist.gov/)

### Implementation Guides
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2024-12-05 | 1.0.0 | Initial security audit completed |
