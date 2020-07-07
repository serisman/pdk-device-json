# pdk-device-json
This repository contains .json files describing Padauk microcontrollers, including fuse settings and IO registers (addresses and values).

These .json files can be useful as a comparison tool, or as input into a code or documentation generator.

There is a ripper utility (node.js app) in the [PDK_INC_Parser](PDK_INC_Parser) folder than can (re)generate these .json files from the .INC files that ship with the official PADAUK IDE. 

To run the node.js ripper utility:
- Install node.js (if you don't have it already)
- Open a terminal/command prompt to the PDK_INC_Parser folder.
- `npm install`
- `node parse_inc.js -s <source PDK INC file> -d <destination file>`
