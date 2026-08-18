# Vast Control Panel Access

This Terraform configuration manages only the two private, self-hosted Access
applications and their shared, deny-by-default administrator policy. It never
creates an Access application for either public Relay hostname.

The applications were first created in the dashboard so Access protected the
hostnames before the Workers were deployed. `imports.tf` adopts those exact
resources on the first apply; it does not create duplicates.

Prerequisites:

1. Activate Cloudflare Zero Trust for the account.
2. Select the existing strong identity provider and copy its UUID. The deployed
   provider is `Cloudflare` (`d5c12185-788b-4b09-84b1-5d9cc4e0d770`).
3. Create a short-lived API token with `Access: Apps and Policies Write`.
4. Install Terraform 1.8 or later.

Keep the token, administrator email, and any state backend credentials outside
Git:

```powershell
$env:CLOUDFLARE_API_TOKEN = '<short-lived-token>'
$env:TF_VAR_cloudflare_account_id = '<account-id>'
$env:TF_VAR_authorized_admin_email = '<exact-admin-email>'
$env:TF_VAR_identity_provider_id = '<idp-uuid>'
terraform init
terraform plan -out vast-control-panel.tfplan
terraform apply vast-control-panel.tfplan
terraform output application_audiences
```

The checked-in imports adopt these dashboard-created resources:

| Environment | Access application ID | AUD |
| --- | --- | --- |
| staging | `5056229e-1e8e-4c66-aa7e-9c00a8fccea0` | `d57429a0aa7ef593c1a7eac956cfce93eb284f518625454b55b6a25787ef0866` |
| production | `518846fd-4461-4954-aec7-4d1667fc0b99` | `c17baacc642c0b105daaed3561596520d3702e60dac54876d000fc672e9690d3` |

The shared policy ID is `2077a868-a2ba-4638-af99-1a5b758367f0`.
The matching non-secret audience values are already present in
`admin/wrangler.jsonc`. Confirm an unauthorized identity is denied before
deploying the Control Panel Worker.

The configuration has no `everyone`, `bypass`, domain-wide email, or public
Relay rule. Unmatched requests are denied by Access, and the Worker separately
validates Access's JWT signature, issuer, audience, expiry, and email claim.
Both applications allow only the configured Cloudflare IdP, use a six-hour
session, HttpOnly and Lax SameSite cookies, and a binding cookie. Lax is required
for the Access top-level authentication redirect while the binding cookie and
application JWT validation continue to protect the session. Access-native
MFA is deliberately not enabled until the administrator has enrolled a recovery-
safe authenticator; enforce MFA on the Cloudflare account/IdP in the meantime.

For the optional automated staging test only, set
`TF_VAR_staging_service_token_id` to an existing short-lived service-token UUID.
This adds one exact Service Auth rule to staging; it never changes the production
application. Supply the token pair to the test through its documented
environment variables and revoke the token after validation.
