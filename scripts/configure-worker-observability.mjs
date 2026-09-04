const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim()
const scripts = process.argv.slice(2)
if (!/^[a-f0-9]{32}$/i.test(accountId) || !token || scripts.length === 0) {
  throw new Error('Usage requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and at least one Worker script name.')
}

for (const script of scripts) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(script)) throw new Error(`Invalid Worker script name: ${script}`)
  const isStaging = script.endsWith('-staging')
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/script-settings`
  const observability = {
    enabled: true,
    logs: {
      enabled: true,
      invocation_logs: false,
      head_sampling_rate: isStaging ? 0.2 : 0.05,
      persist: true
    },
    traces: {
      enabled: true,
      head_sampling_rate: isStaging ? 0.05 : 0.01,
      persist: true
    },
    redact_query_string: true
  }
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ observability })
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.success !== true) throw new Error(`Could not configure sanitized observability for ${script} (HTTP ${response.status}).`)

  const verificationResponse = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const verification = await verificationResponse.json().catch(() => null)
  const actual = verification?.result?.observability
  const expectedLogRate = observability.logs.head_sampling_rate
  const expectedTraceRate = observability.traces.head_sampling_rate
  if (
    !verificationResponse.ok ||
    verification?.success !== true ||
    actual?.enabled !== true ||
    actual?.redact_query_string !== true ||
    actual?.logs?.enabled !== true ||
    actual?.logs?.invocation_logs !== false ||
    actual?.logs?.persist !== true ||
    actual?.logs?.head_sampling_rate !== expectedLogRate ||
    actual?.traces?.enabled !== true ||
    actual?.traces?.persist !== true ||
    actual?.traces?.head_sampling_rate !== expectedTraceRate
  ) {
    throw new Error(`Cloudflare did not persist the required sanitized observability settings for ${script}.`)
  }
  console.log(JSON.stringify({
    ok: true,
    script,
    redactQueryString: true,
    invocationLogs: false,
    logSamplingRate: expectedLogRate,
    traceSamplingRate: expectedTraceRate
  }))
}
