export async function verifyAndAuthorize(
  verify: () => Promise<number>,
  authorize: () => Promise<void>,
  fail: (error: unknown) => void,
  warn: (error: unknown) => void,
): Promise<number> {
  let exitCode = 1;
  try {
    exitCode = await verify();
  } catch (error) {
    fail(error);
  }
  try {
    await authorize();
  } catch (error) {
    warn(error);
  }
  return exitCode;
}
