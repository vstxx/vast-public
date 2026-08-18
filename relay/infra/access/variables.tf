variable "cloudflare_account_id" {
  description = "Cloudflare account that owns vastbrowser.com and Vast Relay."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character Cloudflare account ID."
  }
}

variable "authorized_admin_email" {
  description = "The one exact administrator identity allowed into both control panels."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.authorized_admin_email))
    error_message = "authorized_admin_email must be one complete email address."
  }
}

variable "identity_provider_id" {
  description = "Cloudflare Access identity-provider UUID. Use the existing strong IdP; do not use an unrestricted OTP policy."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.identity_provider_id))
    error_message = "identity_provider_id must be a UUID."
  }
}

variable "staging_service_token_id" {
  description = "Optional service-token resource UUID for automated staging verification. Never set this for production."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.staging_service_token_id == null || can(regex("^[0-9a-fA-F-]{36}$", var.staging_service_token_id))
    error_message = "staging_service_token_id must be null or a service-token resource UUID."
  }
}
