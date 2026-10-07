// alexa-cookie2 ships no typings; this declares only what src/ uses.
declare module 'alexa-cookie2' {
  type Callback = (err: unknown, result: unknown) => void;
  const alexaCookie: {
    generateAlexaCookie(email: string, password: string, options: Record<string, unknown>, callback: Callback): void;
    refreshAlexaCookie(options: Record<string, unknown>, callback: Callback): void;
    stopProxyServer(callback?: () => void): void;
  };
  export default alexaCookie;
}
