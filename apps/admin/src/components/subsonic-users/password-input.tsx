import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { MAX_PASSWORD_LENGTH } from "@/lib/errors";

/**
 * A new Subsonic password, with a button that shows it or hides it again
 * (#82): the owner types it once, and can read it back before saving, in
 * place of a confirmation field. It is shown in no other place: the server
 * never answers a password.
 */
export function PasswordInput(props: Omit<ComponentProps<typeof InputGroupInput>, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <InputGroup>
      <InputGroupInput
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={MAX_PASSWORD_LENGTH}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          // A toggle: one name, and whether it is on.
          aria-label="Show password"
          aria-pressed={visible}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
