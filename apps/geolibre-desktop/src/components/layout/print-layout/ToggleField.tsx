interface ToggleFieldProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

/** A labelled checkbox row for toggling a map element on or off. */
export function ToggleField({ id, label, checked, disabled, onChange }: ToggleFieldProps) {
  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-2 text-sm ${
        disabled ? "cursor-default opacity-50" : "cursor-pointer"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
