export function shouldFetchGithubStars({ prefersReducedMotion, screenshotCapture }) {
  if (screenshotCapture) return false;
  if (prefersReducedMotion) return false;
  return true;
}
