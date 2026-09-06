const ROBOT_ASCII = "                  +##+                  \n                 +####+                 \n                 ######                 \n                +######+                \n           .++############++.           \n       .+######################+.       \n     .############################.     \n    +##############################+    \n  .##################################.  \n .####++########################++####. \n ###.    +####################+    .### \n.###     .####################.     ###.\n+###+    ######################    +###+\n########################################\n+######################################+\n++++++++########################++++++++\n##########++++++++++++++++++++##########\n  .##################################.  \n  .###+    .....+######+.....    +###.  \n  ##+            ######            +##  \n  +.             +####+             .+  \n                  ####                  \n                  .##.";

export type EyeFrame = "open" | "half" | "closed" | "left" | "right" | "happy" | "up" | "down" | "upLeft" | "upRight" | "downLeft" | "downRight";
export type MascotMood = "idle" | "loading" | "happy";
const eyes: Record<EyeFrame, string[]> = {
  open: ["##  ##", "#    #", "      ", "#    #", "##  ##"],
  half: ["######", "######", "      ", "#    #", "######"],
  closed: ["######", "######", "------", "######", "######"],
  left: ["##  ##", "#    #", " #    ", "#    #", "##  ##"],
  right: ["##  ##", "#    #", "    # ", "#    #", "##  ##"],
  up: ["##  ##", "# ## #", "      ", "#    #", "##  ##"],
  down: ["##  ##", "#    #", "      ", "# ## #", "##  ##"],
  upLeft: ["##  ##", "##   #", "      ", "#    #", "##  ##"],
  upRight: ["##  ##", "#   ##", "      ", "#    #", "##  ##"],
  downLeft: ["##  ##", "#    #", "      ", "##   #", "##  ##"],
  downRight: ["##  ##", "#    #", "      ", "#   ##", "##  ##"],
  happy: ["######", "##  ##", "# ## #", " #####", "######"],
};

export function mascotFrame(frame: EyeFrame): string {
  const rows = ROBOT_ASCII.split("\n").map(row => row.padEnd(40, " ").split(""));
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 6; x++) {
      rows[9+y][4+x] = eyes[frame][y][x];
      // Mirror the smile, but keep both pupils looking in the same direction.
      rows[9+y][30+x] = eyes[frame][y][frame === "happy" ? 5-x : x];
    }
  }
  return rows.map(row => row.join("")).join("\n");
}
export const sequences: Record<MascotMood, readonly (readonly [EyeFrame, number])[]> = {
  idle: [["open", 4200], ["half", 60], ["closed", 90], ["half", 60]],
  loading: [["left", 950], ["right", 950], ["half", 60], ["closed", 90]],
  happy: [["happy", 1000]],
};
