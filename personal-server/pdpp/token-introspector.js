import { CoreOperationError } from "./operations.js"

/** Resolve opaque bearer credentials without inspecting their syntax locally. */
export function createHttpTokenIntrospector({
  url,
  authorization,
  fetchImpl = fetch,
}) {
  return {
    async introspect(token) {
      if (!url) {
        throw new CoreOperationError(
          500,
          "internal_error",
          "Token introspection is not configured"
        )
      }
      const headers = { "content-type": "application/x-www-form-urlencoded" }
      if (authorization) headers.authorization = authorization
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: new URLSearchParams({ token }),
      })
      if (!response.ok) {
        throw new CoreOperationError(
          500,
          "internal_error",
          "Token introspection failed"
        )
      }
      return response.json()
    },
  }
}
