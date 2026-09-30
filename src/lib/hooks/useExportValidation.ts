import { useRef, useState } from "react";
import { validateImageExport, validateVideoExport, type ExportValidationReport } from "../media/export-validation";

export type ExportValidationExpectation =
  | { kind: "image"; width: number; height: number; expectAlpha: boolean }
  | { kind: "video"; width: number; height: number; fps?: number; expectAlpha: boolean };

/**
 * PHASE 13 — TRANSPARENT EXPORT. Runs the automatic post-export
 * verification pass (src/lib/media/export-validation.ts) against whatever
 * blob a tool just produced. A token guard drops results from a superseded
 * run (e.g. the user starts a second export before the first one's
 * validation — which decodes the file again — has finished).
 */
export function useExportValidation() {
  const [report, setReport] = useState<ExportValidationReport | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const tokenRef = useRef(0);

  const validate = async (blob: Blob, expected: ExportValidationExpectation) => {
    const token = ++tokenRef.current;
    setIsValidating(true);
    setReport(null);
    try {
      const result = expected.kind === "image" ? await validateImageExport(blob, expected) : await validateVideoExport(blob, expected);
      if (tokenRef.current === token) setReport(result);
    } catch (error) {
      console.error(error);
      if (tokenRef.current === token) {
        setReport({
          passed: false,
          checks: [{ id: "file-readable", label: "File is readable", passed: false, detail: "Validation itself failed to run." }],
        });
      }
    } finally {
      if (tokenRef.current === token) setIsValidating(false);
    }
  };

  const reset = () => {
    tokenRef.current += 1;
    setReport(null);
    setIsValidating(false);
  };

  return { report, isValidating, validate, reset };
}
