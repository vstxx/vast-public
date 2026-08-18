// These resources were bootstrapped in the Cloudflare dashboard so Access was
// protecting the hostnames before either Control Panel Worker was deployed.
// Import blocks make the dashboard-created resources adoptable without creating
// a duplicate application or policy.

import {
  to = cloudflare_zero_trust_access_policy.control_panel_admin
  id = "967b1eb285d30cf18237df70bd94341d/2077a868-a2ba-4638-af99-1a5b758367f0"
}

import {
  to = cloudflare_zero_trust_access_application.control_panel["staging"]
  id = "accounts/967b1eb285d30cf18237df70bd94341d/5056229e-1e8e-4c66-aa7e-9c00a8fccea0"
}

import {
  to = cloudflare_zero_trust_access_application.control_panel["production"]
  id = "accounts/967b1eb285d30cf18237df70bd94341d/518846fd-4461-4954-aec7-4d1667fc0b99"
}
