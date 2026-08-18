output "application_ids" {
  description = "Cloudflare Access application IDs by environment."
  value       = { for name, app in cloudflare_zero_trust_access_application.control_panel : name => app.id }
}

output "application_audiences" {
  description = "Non-secret AUD values that must be copied into the matching Wrangler environment."
  value       = { for name, app in cloudflare_zero_trust_access_application.control_panel : name => app.aud }
}

output "administrator_policy_id" {
  description = "Reusable deny-by-default administrator policy attached to both applications."
  value       = cloudflare_zero_trust_access_policy.control_panel_admin.id
}
