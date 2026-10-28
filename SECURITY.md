# Security / 安全说明

Relay exposes a host-user shell to anyone holding its access credential. It is intended for trusted personal devices, not a multi-tenant/public terminal service. No shell sandbox, per-device credentials, automatic credential expiry, or structured Codex approval binding is provided.

Relay 会向持有访问凭据的人开放电脑当前用户权限的 Shell，适用于可信个人设备，不适合作为多人租户或公开终端服务。它不提供 Shell 沙箱、逐设备凭据、凭据自动过期或结构化 Codex 审批绑定。

Keep `.env`, Cloudflare certificates/tokens, pairing QR codes, credential-bearing URLs, and terminal output private. After exposure, stop Relay, rotate the credential in local configuration, and restart; check other host/account credentials if terminal access was obtained.

请保护 `.env`、Cloudflare 证书/Token、配对二维码、含凭据的链接和终端内容。泄露后停止 Relay，在本地轮换访问凭据并重启；若他人已获得终端权限，还应检查电脑及相关账号的其他凭据。

Report vulnerabilities privately through the repository's [GitHub security advisory page](https://github.com/lmjxff/codex-web-relay/security/advisories/new) if private reporting is available. If it is unavailable, open an issue asking for a private contact without disclosing exploit details or secrets. No response-time guarantee is currently offered.

如已启用私密报告，请通过仓库的 [GitHub 安全报告页面](https://github.com/lmjxff/codex-web-relay/security/advisories/new) 提交。若不可用，请发一个不含漏洞细节、利用步骤或秘密的 Issue，询问私下联系方式。目前不承诺固定响应时限。
