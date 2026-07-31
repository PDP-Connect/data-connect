function normalizeConfiguredUrl(
  envName: string,
  value: string | undefined
): string {
  const candidate = value?.trim()
  if (!candidate) {
    throw new Error(
      `${envName} must be configured before this service can be used`
    )
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`${envName} must be a valid absolute URL`)
  }

  const loopbackHost =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname)

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopbackHost)
  ) {
    throw new Error(`${envName} must use https unless it targets loopback`)
  }

  return url.href.replace(/\/$/, "")
}

export function configuredServiceUrl(
  envName: string,
  value: string | undefined
): string {
  return normalizeConfiguredUrl(envName, value)
}

export function configuredTunnelAddress(value: string | undefined): string {
  const address = value?.trim()
  if (!address) {
    throw new Error(
      "VITE_TUNNEL_SERVER_ADDR must be configured before server registration can be used"
    )
  }

  return address
}
