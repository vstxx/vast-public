locals {
  administrator_email = lower(trimspace(var.authorized_admin_email))
  applications = {
    staging = {
      name   = "Vast Control Panel — Staging"
      domain = "controlpanel-staging.vastbrowser.com"
    }
    production = {
      name   = "Vast Control Panel"
      domain = "controlpanel.vastbrowser.com"
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "control_panel_admin" {
  account_id       = var.cloudflare_account_id
  name             = "Allow named Vast administrator"
  decision         = "allow"
  session_duration = "6h"

  include = [{
    email = {
      email = local.administrator_email
    }
  }]

  require = [{
    login_method = {
      id = var.identity_provider_id
    }
  }]

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "control_panel" {
  for_each = local.applications

  account_id = var.cloudflare_account_id
  name       = each.value.name
  domain     = each.value.domain
  type       = "self_hosted"

  destinations = [{
    type = "public"
    uri  = each.value.domain
  }]

  allowed_idps              = [var.identity_provider_id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false
  session_duration          = "6h"

  allow_authenticate_via_warp = false
  allow_iframe                = false
  enable_binding_cookie       = true
  http_only_cookie_attribute  = true
  same_site_cookie_attribute  = "lax"
  options_preflight_bypass    = false

  policies = concat(
    [{
      id         = cloudflare_zero_trust_access_policy.control_panel_admin.id
      precedence = 1
    }],
    each.key == "staging" && var.staging_service_token_id != null ? [{
      name       = "Service Auth for staging verification"
      decision   = "non_identity"
      precedence = 2
      include = [{
        service_token = {
          token_id = var.staging_service_token_id
        }
      }]
    }] : []
  )
}
