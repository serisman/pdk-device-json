const _ = require('lodash');
const fs = require('fs');
const stream = require('stream');
const util = require('util');
const readline = require('linebyline');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

const optionDefinitions = [
  {name: 'src', alias: 's', type: String, description: 'The source PDK .INC file to parse.'},
  {name: 'dest', alias: 'd', type: String, description: 'The destination .json file to write.'},
  {name: 'help', alias: 'h', type: Boolean, description: 'Print this usage guide.'},
];
const options = commandLineArgs(optionDefinitions);

// Defaults (also controls order)
const destObject = {
  prog: {id: null, method: null},
  rom: {type: 'OTP'},
  ram: {},
  instrSet: {},
  fppa: {},
  fuse: {
    lowBits: [],
    options: []
  },
  registers: [],
  //peripherals: [],
};

const streamFinished = util.promisify(stream.finished);

async function main() {
  if (options.help) {
    return console.log(commandLineUsage([{
      header: 'PDK INC Parser',
      content: 'This application parses source PDK .INC files into a .json format.'
    }, {
      header: 'Options',
      optionList: optionDefinitions
    }]));
  }
  if (!options.src) {
    return console.log('Missing -s, --src option');
  }
  if (!options.dest) {
    return console.log('Missing -d, --dst option');
  }

  const srcFile = readline(options.src);
  srcFile.on('error', error => {
    return console.log(error);
  });

  let isInComment = false;
  let isInHeaderSection = true;
  let isInAsmSection = false;
  let isInRegisterSection = false;
  let isInICE = false;
  let prevRegister;
  let registerValue;

  srcFile.on('line', (line, lineCount) => {
    //console.log(lineCount, data);
    line = _.trimStart(line, '\t');

    if (line.length === 0) {
      return;
    } else if (_.startsWith(line, '//')) {
      return;
    } else if (_.startsWith(line, '/*')) {
      isInComment = true;
      return;
    } else if (_.startsWith(line, '*/')) {
      isInComment = false;
      return;
    } else if (isInComment) {
      return;
    }

    if (isInHeaderSection) {
      trySetIntValue(line, '.Assembly\tRAM_Size', 'ram.size');
      trySetIntValue(line, '.Assembly\tROM_Size', 'rom.size');
      trySetIntValue(line, '.Assembly\tUSER_SIZE', 'rom.userSize');
      trySetROMType(line, '.Assembly\tBOOT_TYPE', 'rom.type');
      trySetHexValue(line, '.Assembly\tOTP_ID', 'prog.id');
      trySetHexValue(line, '.Assembly\tOTP_WAY', 'prog.method');
      trySetInstrSet(line, '.Assembly\tASM_INSTR', 'instrSet');
      trySetIntValue(line, '.Assembly\tFPPA_NUM', 'fppa.count');
    } else if (isInAsmSection) {
      trySetFuseOption(line, '.Assembly\tOPTION\t', 'fuse.options');
      trySetFuseLowBits(line, '.Assembly\tOPTION_LOW', 'fuse.lowBits');
    } else if (isInRegisterSection) {

      if (_.startsWith(line, '#if\t_SYS(AT_ISP_ICE)')) {
        isInICE = true;
        return;
      } else if (_.startsWith(line, '#else')) {
        isInICE = false;
        return;
      } else if (_.startsWith(line, '#endif')) {
        isInICE = false;
        return;
      } else if (!isInICE) {
        const newRegister = tryAddRegister(line, 'registers');
        if (newRegister) {
          if (registerValue) {
            addRegisterValues(prevRegister, registerValue);
            registerValue = null;
          }
          prevRegister = newRegister;
        } else {

          if (_.some(['IO_RW', 'IO_RXW', 'IO_WR', 'IO_WO', 'IO_RO', 'IO_DI'], a => line.indexOf(a) > 0)) {
            console.log('Unhandled Register Values:', line);
            // TODO...
          } else if (_.startsWith(line, '$')) {
            if (registerValue) {
              addRegisterValues(prevRegister, registerValue);
              registerValue = null;
            }
            registerValue = line.substring(2);
          } else if (registerValue) {
            registerValue += ' ' + line;
          }
        }
      }
    }

    if (_.startsWith(line, '.Assembly\tASM_INSTR')) {
      isInHeaderSection = false;
      isInAsmSection = true;
    } else if (_.startsWith(line, '.Assembly\tICE_INSTR')) {
      isInAsmSection = false;
    } else if (_.startsWith(line, '.Assembly\tEND_INSTR')) {
      isInAsmSection = false;
      isInRegisterSection = true;
    }
  });

  await streamFinished(srcFile);

  if (registerValue) {
    addRegisterValues(prevRegister, registerValue);
  }

  //console.dir(destObject, { depth: null });
  fs.writeFileSync(options.dest, JSON.stringify(destObject, null, 2));
}

function tryParseLineValue(line, prefix, cb) {
  if (_.startsWith(line, prefix)) {
    cb(_.trimStart(line.substring(prefix.length)));
  }
}

function tryParseIntLine(line, prefix, cb) {
  tryParseLineValue(line, prefix, value => {
    if (_.endsWith(value, 'h')) {
      value = '0x' + _.trimEnd(value, 'h');
    }
    cb(parseInt(value));
  });
}


function trySetIntValue(line, prefix, destPath) {
  tryParseIntLine(line, prefix, value => {
    _.set(destObject, destPath, value);
  });
}

function trySetHexValue(line, prefix, destPath) {
  tryParseIntLine(line, prefix, value => {
    _.set(destObject, destPath, '0x' + value.toString(16));
  });
}

function trySetROMType(line, prefix, destPath) {
  tryParseLineValue(line, prefix, value => {
    _.set(destObject, destPath, value === '4' ? 'FlASH' : 'OTP');
  });
}

function trySetInstrSet(line, prefix, destPath) {
  tryParseLineValue(line, prefix, value => {
    _.set(destObject, destPath, getInstrSet(value));
  });
}

function trySetFuseOption(line, prefix, destPath) {
  tryParseLineValue(line, prefix, value => {
    const values = value.replace(/\s+/g, '\t').split('\t');
    const options = values.slice(2);
    let fuseOptions = _.get(destObject, destPath, []);
    fuseOptions.push({
      name: values[1],
      startBit: parseInt(values[0]),
      numBits: getNumBitsByLength(options.length),
      values: options
    });
    _.set(destObject, destPath, _.sortBy(fuseOptions, 'startBit'));
  });
}

function trySetFuseLowBits(line, prefix, destPath) {
  tryParseLineValue(line, prefix, value => {
    const values = value.split(', ');
    const fuseLowBits = [];
    for (let value of values) {
      if (_.includes(value, '~')) {
        const values2 = value.split('~');
        const startBit = parseInt(values2[0]);
        const endBit = parseInt(values2[1]);
        for (let bit = startBit; bit <= endBit; bit++) {
          fuseLowBits.push(bit);
        }
      } else {
        fuseLowBits.push(parseInt(value));
      }
    }
    _.set(destObject, destPath, fuseLowBits);
  });
}

function tryAddRegister(line, destPath) {
  if (_.some(['IO_RW', 'IO_RXW', 'IO_WR', 'IO_WO', 'IO_RO', 'IO_DI'], a => line.indexOf(a) > 0)) {
    const values = line.replace(/\s+/g, '\t').split('\t');
    const addr = values[2];
    if (_.startsWith(addr, '0x')) {
      const register = {
        name: values[0],
        address: addr,
        access: values[1],
      };
      let registers = _.get(destObject, destPath, []);
      registers.push(register);
      _.set(destObject, destPath, _.sortBy(registers, 'name'));
      return register;
    }
  }
}

function addRegisterValues(prevRegister, registerValues) {
  let values = registerValues.replace(/\s+/g, '\t').split('\t');

  // Remove weirdness with alternate functions
  if (_.startsWith(values[1], '@') || _.startsWith(values[1], '#') || _.startsWith(values[1], '%')) {
    _.pullAt(values, 1);
  }
  if (_.startsWith(values[3], '@') || _.startsWith(values[3], '#') || _.startsWith(values[3], '%')) {
    _.pullAt(values, 3);
  }
  // Remove comments
  const cmtIdx = _.findIndex(values, v => v === '//');
  if (cmtIdx > 0) {
    values = _.slice(values, 0, cmtIdx);
  }
  //console.log(prevRegister.name, values);

  let setting;

  // Ignore dumb stuff
  if (values.length === 3 && values[1] === '=' && (values[2] === 'X' || values[2] === '0')) {
    setting = {};
    values = values.slice(2);
  }
  // Handle single bit settings
  if (values[1] === ':' || values[1] === 'R') {
    setting = {
      startBit: parseInt(values[0]),
      numBits: 1,
    };
    if (values[1] === 'R') {
      setting.readOnly = true;
    }
    values = values.slice(2);
  }

  // Handle multi-bit settings
  if (values[1] === '~' && (values[3] === ':' || values[3] === '=')) {
    const endBit = parseInt(values[0]);
    const startBit = parseInt(values[2]);
    setting = {
      startBit,
      numBits: endBit-startBit+1,
    }
    values = values.slice(4);

    // Special cases...
    if (values[0] === 'GPCS') {
      values = [];
    }
    if (values[1] === '~') {
      const start = parseInt(_.trimStart(values[0], '/'));
      const end = parseInt(_.trimStart(values[2], '/'));
      values = [];
      for (let i=start; i<=end; i++) {
        values.push(`/${i}${i===end ? '' : ','}`);
      }
    }
  }

  // Handle weird CLKMD system clock setting
  if (values[1] === '~' && values[4] === ':') {
    const endBit = parseInt(values[0]);
    const startBit1 = parseInt(values[3]);
    const startBit2 = parseInt(_.trimEnd(values[2], ','));
    setting = {
      startBit: startBit1,
      numBits: endBit - startBit2 + 1 + 1,
      skipBit: startBit1+1,
    }
    values = values.slice(5);
  }

  if (setting) {
    const cIdx = _.findIndex(values, v => v === ':');
    if (cIdx > 0) {
      values = _.slice(values, 0, cIdx);
    }
    values = values.join(' ').split(', ');
    if (values.length === 1 && values[0] === 'X') {
      return;
    }
    if (values.length && values[0].length) {
      setting.values = values;
    }
    prevRegister.settings = prevRegister.settings || [];
    prevRegister.settings.push(setting);
    prevRegister.settings = _.sortBy(prevRegister.settings, 'startBit');
  } else {
    console.log('Unhandled Register Setting:', prevRegister.name, values);
  }
}

function getInstrSet(value) {
  switch (value) {
    case 'SYM_84B':
      return '13 bit';
    case 'SYM_85A':
      return '14 bit';
    case 'SYM_86B':
      return '15 bit';
    default:
      throw new Error(`Unknown ASM_INSTR value: ${value}`);
  }
}

function getNumBitsByLength(length) {
  if (length > 128) return 8;
  else if (length > 64) return 7;
  else if (length > 32) return 6;
  else if (length > 16) return 5;
  else if (length > 8) return 4;
  else if (length > 4) return 3;
  else if (length > 2) return 2;
  else return 1;
}

main()
  .catch(err => {
    console.error(err);
  });
