# Native request composition contract

Status: accepted by the isolated Electron 44.3.0 HTTP/WebSocket gate on 2026-09-19. The final diff is in `0004-electron-composed-webrequest-lifecycle.patch`; the limitations below still apply.

Stock Electron 44.3.0 selects either the Electron `ProxyingURLLoaderFactory` or Chromium's extension `WebRequestProxyingURLLoaderFactory` in `ElectronBrowserClient::WillCreateURLLoaderFactory`. It makes the same exclusive choice for WebSocket handshakes in `CreateWebSocket`. The choice is made when a factory is created, so adding an app listener later cannot repair an existing extension-routed factory.

The required patch must use one per-request arbiter and one final continuation into the network service. Both listener systems may contribute decisions, but neither may independently finalize a request when both are active. For each redirect hop, the arbiter must:

1. Obtain the app `onBeforeRequest` decision. An app cancel ends the request before extension dispatch. An app redirect takes precedence and restarts evaluation on the redirected URL.
2. Dispatch the extension `onBeforeRequest` event. Its cancel is effective only after app allow; its redirect restarts evaluation at step 1 so the target passes app policy. Keep Chromium's asynchronous listener completion and request-destruction cleanup.
3. Apply extension request-header changes, then enforce the app's final request-header set/remove delta. Preserve extension changes to headers the app did not control. Use the same rule for the WebSocket handshake.
4. Dispatch response-header events and enforce the app's final response-header set/remove delta before the renderer sees headers. Never let an extension remove an app security header.
5. On auth, app cancellation or credentials take precedence; an extension may answer only when the app abstains. Preserve the stock auth request identity and callback lifetime.

Observer events must be emitted once. A listener exception, disconnect or timeout must not change an app cancel into allow. Requests with zero extension listeners must behave as Electron app requests; requests with zero app listeners must behave as Chromium extension requests. HTTP, HTTPS, WebSocket, redirects, CORS preflights, service-worker requests and browser-process requests need explicit coverage.

Merely appending both existing factories is **not** this arbiter. `URLLoaderFactoryBuilder::Append()` chains factories in order. Request headers and response headers traverse that chain in opposite directions, and extension redirects/auth can end the flow before the app reaches its policy point. The chain experiment is useful for instrumentation but is not an acceptable security patch.

## Accepted implementation and remaining limits

The isolated checkout routes HTTP(S) and WebSocket traffic through Electron's existing proxy and invokes Chromium's `WebRequestEventRouter` at each relevant stage. It also uses Chromium's existing request-ID auth lookup to hand HTTP authentication to extensions only after the Electron `login` event abstains. App cancellation and app credentials are final. The same priority applies to WebSocket auth.

WebSocket redirects currently fail closed because this proxy has no `FollowRedirect` operation that can re-check the destination with the app policy. This must be measured against the target extensions and either implemented safely or documented as unsupported. HTTP redirects are re-evaluated through the existing per-hop request lifecycle.

The patched executable passes the deterministic HTTP and WebSocket matrix for app-only, extension-only, both listener-registration orders, and no-listener baselines. It also passes the app-first authentication cases in the harness. The gate proves the policy invariants exercised by that harness; it does not replace broader HTTPS, proxy, CORS-preflight, multi-extension, timeout, and production traffic soak tests.
