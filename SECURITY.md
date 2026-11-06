# Security

## Threat model

Gateway Console is meant to run on one machine and be used from a browser on that same machine. It proxies requests to a gateway on the local network using the gateway's own admin credentials, which the user types in.

What it defends against:

- **Other machines on the network.** The server binds to `127.0.0.1` only.
- **DNS rebinding and forged hosts.** Requests whose `Host` or `Origin` header is not `localhost`, `127.0.0.1`, or `[::1]` on the configured port are refused.
- **Cross-site requests from a malicious web page in the user's browser.** Gateway calls require a custom `X-Gateway-Console` header. Browsers only send custom headers after a CORS preflight, and the server never answers one, so a page on another origin cannot reach the gateway through the proxy.
- **Injected script in the UI.** A Content Security Policy restricts scripts and connections to the console's own origin.
- **Credential leakage.** The gateway password is forwarded once to the gateway's login endpoint and never logged or stored. The session token is kept in `sessionStorage` and dies with the tab. Request logs contain method, path, and status only.
- **Accidental disclosure.** The JSON export redacts device identifiers, SIM numbers, Wi-Fi passwords, MACs, and GPS by default.

What it does not defend against:

- Anything else running as the same user on the same machine. Local malware can use the proxy exactly as the user can. That is true of any local tool.
- The gateway itself. The console sends whatever the user asks it to send, including through the raw request builder in the Advanced tab.
- Running it with the server exposed on a network interface. Do not modify it to do that.

## Reporting a vulnerability

Open a GitHub issue if the problem does not reveal a working exploit, or use GitHub's private vulnerability reporting on the repository if it does. Include the gateway model and firmware version if relevant. Please do not include your gateway's serial, IMEI, SIM numbers, or Wi-Fi password in a report; the export tool's default redaction handles that.

## Supported versions

Only the latest release is supported. There is no backporting.
