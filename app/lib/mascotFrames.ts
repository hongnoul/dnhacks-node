const ROBOT_ASCII = "                  +##+                  \n                 +####+                 \n                 ######                 \n                +######+                \n           .++############++.           \n       .+######################+.       \n     .############################.     \n    +##############################+    \n  .##################################.  \n .####++########################++####. \n ###.    +####################+    .### \n.###     .####################.     ###.\n+###+    ######################    +###+\n########################################\n+######################################+\n++++++++########################++++++++\n##########++++++++++++++++++++##########\n  .##################################.  \n  .###+    .....+######+.....    +###.  \n  ##+            ######            +##  \n  +.             +####+             .+  \n                  ####                  \n                  .##.";

export type EyeFrame = "open" | "half" | "closed" | "left" | "right" | "happy" | "up" | "down" | "upLeft" | "upRight" | "downLeft" | "downRight";
export type MascotMood = "idle" | "loading" | "happy";
const aperture = ["###   ###", "#       #", "         ", "         ", "#       #", "###   ###"];

export function eyeOffset(direction: EyeFrame): { x: number; y: number } {
  const d = direction.toLowerCase();
  return { x: d.includes("left") ? -1 : d.includes("right") ? 1 : 0,
    y: d.includes("up") ? -1 : d.includes("down") ? 1 : 0 };
}

export function mascotFrame(frame: EyeFrame, direction: EyeFrame = frame): string {
  const rows = ROBOT_ASCII.split("\n").map(row => row.padEnd(40, " ").split(""));
  // Erase the original small apertures before drawing the larger, mobile eyes.
  for (let y = 9; y < 14; y++) for (const start of [4, 30])
    for (let x = start; x < start + 6; x++) rows[y][x] = "#";
  const offset = eyeOffset(direction);
  const eye = aperture.map(row => row.split(""));
  if (frame === "closed") {
    for (let y = 0; y < 6; y++) eye[y] = (y === 3 ? "---------" : "#########").split("");
  } else if (frame === "half") {
    for (let y = 0; y < 3; y++) eye[y] = "#########".split("");
  } else if (frame === "happy") {
    ["#########", "###   ###", "## ### ##", "# ##### #", "#########", "#########"].forEach((r,y) => eye[y] = r.split(""));
  } else if (frame !== "open") {
    const pupil = eyeOffset(frame);
    const px = 3 + pupil.x * 2, py = 2 + pupil.y;
    for (let y = py; y < py + 2; y++) for (let x = px; x < px + 2; x++) eye[y][x] = "#";
  }
  for (const start of [6, 25]) for (let y = 0; y < 6; y++) for (let x = 0; x < 9; x++) {
    // Transparent corners preserve the dome's outer contour as the eyes move.
    if (eye[y][x] !== "#") rows[8 + offset.y + y][start + offset.x + x] = eye[y][x];
    else if (aperture[y][x] === " ") rows[8 + offset.y + y][start + offset.x + x] = "#";
  }
  return rows.map(row => row.join("")).join("\n");
}
export const sequences: Record<MascotMood, readonly (readonly [EyeFrame, number])[]> = {
  idle: [["open", 4200], ["half", 60], ["closed", 90], ["half", 60]],
  loading: [["left", 950], ["right", 950], ["half", 60], ["closed", 90]],
  happy: [["happy", 1000]],
};
