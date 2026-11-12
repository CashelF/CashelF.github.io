import React from "react";
import { createPortal } from "react-dom";

// Forminit (formerly Getform) emails each submission to Cash, so his address
// never ships with the site.
export const CONTACT_ENDPOINT = process.env.REACT_APP_CONTACT_ENDPOINT || "https://forminit.com/f/f60fe958-484d-4ad4-9db9-48dd01a24228";

const ContactContext = React.createContext(() => {});

export function ContactProvider({ children }) {
  const [open, setOpen] = React.useState(false);
  const openContact = React.useCallback(() => setOpen(true), []);
  const closeContact = React.useCallback(() => setOpen(false), []);
  return (
    <ContactContext.Provider value={openContact}>
      {children}
      <ContactDialog open={open} onClose={closeContact} />
    </ContactContext.Provider>
  );
}

export function useContactDialog() { return React.useContext(ContactContext); }

function ContactDialog({ open, onClose }) {
  const dialogRef = React.useRef(null);
  const [status, setStatus] = React.useState("idle");

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !dialog.showModal) return;
    if (open && !dialog.open) {
      setStatus(current => (current === "sending" ? current : "idle"));
      dialog.showModal();
      const firstField = dialog.querySelector("input, textarea");
      if (firstField) firstField.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    // Escape and form-method="dialog" close the element directly; keep state in sync.
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, [onClose]);

  const handleSubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get("company")) {
      // Honeypot filled in: pretend it worked.
      setStatus("sent");
      return;
    }
    data.delete("company");
    setStatus("sending");
    try {
      const response = await fetch(CONTACT_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: data,
      });
      if (!response.ok) throw new Error(`Contact form returned ${response.status}`);
      form.reset();
      setStatus("sent");
    } catch (error) {
      console.error(error);
      setStatus("error");
    }
  };

  const handleBackdropClick = event => {
    if (event.target === dialogRef.current) onClose();
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="contact-dialog"
      aria-labelledby="contact-dialog-title"
      data-robot-ignore="true"
      onClick={handleBackdropClick}
    >
      <div className="contact-dialog__panel">
        <div className="contact-dialog__header">
          <p className="eyebrow">SAY HELLO</p>
          <button type="button" className="contact-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {status === "sent" ? (
          <div className="contact-dialog__done" role="status">
            <h2 id="contact-dialog-title">Thanks, message sent.</h2>
            <p>I’ll get back to you at the email you left.</p>
            <button type="button" className="contact-dialog__submit" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 id="contact-dialog-title">Leave me a message</h2>
            <label>
              Name
              <input type="text" name="fi-sender-fullName" autoComplete="name" maxLength={120} />
            </label>
            <label>
              Your email
              <input type="email" name="fi-sender-email" autoComplete="email" required maxLength={200} />
            </label>
            <label>
              Message
              <textarea name="fi-text-message" rows={5} required maxLength={5000} />
            </label>
            <label className="contact-dialog__trap" aria-hidden="true">
              Company
              <input type="text" name="company" tabIndex={-1} autoComplete="off" />
            </label>
            {status === "error" && (
              <p className="contact-dialog__error" role="alert">
                That didn’t go through. Please try again in a moment.
              </p>
            )}
            <button type="submit" className="contact-dialog__submit" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Send"} <span aria-hidden="true">→</span>
            </button>
          </form>
        )}
      </div>
    </dialog>,
    document.body
  );
}
