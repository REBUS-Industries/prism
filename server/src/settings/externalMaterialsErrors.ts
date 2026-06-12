/** Thrown when admin PATCH external-materials settings contain invalid values. */
export class ExternalMaterialsSettingsError extends Error {
  constructor(
    message: string,
    readonly field: 'fab.httpProxy' | 'fab.flareSolverrUrl',
  ) {
    super(message);
    this.name = 'ExternalMaterialsSettingsError';
  }
}
