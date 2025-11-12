declare module 'input' {
  const mod: {
    text(prompt?: string): Promise<string>;
  };
  export default mod;
}
