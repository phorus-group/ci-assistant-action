/**
 * Custom Jest resolver that adds the "import" condition for ESM-only packages.
 * Required because @actions/* v3 and @octokit/* are ESM-only and only expose
 * the "import" condition in their package.json exports field.
 */
const ESM_PACKAGES = ["@actions/", "@octokit/", "universal-user-agent", "before-after-hook", "deprecation"]

module.exports = (request, options) => {
  const needsImport = ESM_PACKAGES.some((pkg) => request.startsWith(pkg))
  if (needsImport) {
    return options.defaultResolver(request, {
      ...options,
      conditions: [...new Set([...(options.conditions || []), "import"])],
    })
  }
  return options.defaultResolver(request, options)
}
