export function redactAvidaeLogLine(line: string, launchToken?: string): string {
  return (launchToken ? line.split(launchToken).join('[redacted]') : line)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|code|password|access_token|refresh_token)=)[^&#\s]*/gi, '$1[redacted]')
}
