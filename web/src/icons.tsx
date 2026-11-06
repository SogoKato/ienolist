// Line icons. They are decoration: the button or link around each one says what it does.
const icon = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const PencilIcon = () => (
  <svg {...icon}>
    <path d="M4 20l1-4L15.5 5.5a2.12 2.12 0 0 1 3 3L8 19z" />
    <path d="M13.5 7.5l3 3" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...icon}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

// Eight teeth around a hole.
export const GearIcon = () => (
  <svg {...icon}>
    <path d="M19.41 10.29L21.88 10.44A10 10 0 0 1 21.88 13.56L19.41 13.71A7.6 7.6 0 0 1 18.45 16.03L20.09 17.88A10 10 0 0 1 17.88 20.09L16.03 18.45A7.6 7.6 0 0 1 13.71 19.41L13.56 21.88A10 10 0 0 1 10.44 21.88L10.29 19.41A7.6 7.6 0 0 1 7.97 18.45L6.12 20.09A10 10 0 0 1 3.91 17.88L5.55 16.03A7.6 7.6 0 0 1 4.59 13.71L2.12 13.56A10 10 0 0 1 2.12 10.44L4.59 10.29A7.6 7.6 0 0 1 5.55 7.97L3.91 6.12A10 10 0 0 1 6.12 3.91L7.97 5.55A7.6 7.6 0 0 1 10.29 4.59L10.44 2.12A10 10 0 0 1 13.56 2.12L13.71 4.59A7.6 7.6 0 0 1 16.03 5.55L17.88 3.91A10 10 0 0 1 20.09 6.12L18.45 7.97A7.6 7.6 0 0 1 19.41 10.29Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const BackIcon = () => (
  <svg {...icon}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);
