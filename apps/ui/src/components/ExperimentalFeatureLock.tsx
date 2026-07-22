import "./ExperimentalFeatureLock.css";

export const EXPERIMENTAL_FEATURE_LOCKED_MESSAGE =
  "Experimental feature. Enable it in Settings → Experimental features.";

interface ExperimentalFeatureLockProps {
  descriptionId: string;
}

/** Shared explanation for an experimental control that remains visible while locked. */
export function ExperimentalFeatureLock({ descriptionId }: ExperimentalFeatureLockProps) {
  return (
    <>
      <span id={descriptionId} className="experimental-feature-lock__sr-only">
        {EXPERIMENTAL_FEATURE_LOCKED_MESSAGE}
      </span>
      <span className="experimental-feature-lock__tooltip" role="tooltip">
        {EXPERIMENTAL_FEATURE_LOCKED_MESSAGE}
      </span>
    </>
  );
}
