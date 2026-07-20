// dbd_files: []

type DBDHeader = {
    dbd_label?: string
    encoding_ver?: number
    num_ascii_tags?: number
    all_sensors?: string
    the8x3_filename?: string
    full_filename?: string
    filename_extension?: string
    mission_name?: string
    fileopen_time?: string
    total_num_sensors?: number
    sensors_per_cycle?: number
    state_bytes_per_cycle?: number
    sensor_list_crc?: string
    sensor_list_factored?: number
}
type SensorMap = {
    [key: string]: number
}

type Sensor = {
    transmitted: boolean
    num: number
    index: number
    bytes: number
    name: string
    units: string
    updated: boolean
    value?: number
}

type DBDRecord = {
    data: (number|null)[],
    updates: number[],
    mods: number[]
}

type ProcessedRecords = {
    sci_m_present_time: Date[];
} & {
    [key: string]: (number | null)[];
}

export class DBDFile{
    #fileobj: File
    #cacheFiles: FileList
    #dataView: DataView | null = null
    #headerobj: DBDHeader = {} as DBDHeader
    #byteState: number = 0
    #isLittleEndian: boolean = true
    #sensorList: Sensor[] = []
    dataRecord: DBDRecord[] = []

    constructor(dbd_file: File, cache_files: FileList){
        this.#fileobj = dbd_file;
        this.#cacheFiles = cache_files
    }
    
    async decode(): Promise<DBDFile>{
        await this.parseHeader()
        const arrayBuffer = await this.#fileobj.arrayBuffer();
        this.#dataView = new DataView(arrayBuffer);   
        await this.get_endian()
        await this.getSensorList()
        console.log(this.#sensorList)
        console.log("Decoding data record")
        while (true){
            let rec = this.parseDataRecord()
            if(!rec)
                break
            this.dataRecord.push(rec)
        }
        console.log("done decoding!")
        return this
    }

    async get_endian(){
        const littleEndian = this.#dataView?.getInt16(this.#byteState+2, true)
        this.#byteState+= 16
        if (littleEndian == 4660) {
            this.#isLittleEndian = true
        }
        else{
            this.#isLittleEndian = false
        }
    }

    async getSensorListFromCache(): Promise<string>{
        let text = ""
        const cacheName = this.#headerobj?.sensor_list_crc + ".cac"
        for(let cacheFile of this.#cacheFiles){
            if (cacheFile.name == cacheName){
                console.log("Found Cache file!")
                text = await cacheFile.text()
            }
        }
        if(text == ""){
            throw "Can't read cache file!"
        }
        return text
    }

    getSensorListFromDBD(): string{
        return ""
    }

    parseSensorList(sensorListStr: string){
        const sensorLines = sensorListStr.split("\n")
        for(let sensorLine of sensorLines) {
            const sensorSplit = sensorLine.split(/\s+/)
            if(sensorSplit[1] != 'T')
                continue
            const bytes = parseInt(sensorSplit[4] as string)
            const sensor: Sensor = {
                transmitted: sensorSplit[0] == 'T',
                num: parseInt(sensorSplit[2] as string),
                index: parseInt(sensorSplit[3] as string),
                bytes: bytes,
                name: sensorSplit[5] as string,
                units: sensorSplit[6] as string,
                updated: false
            }
            this.#sensorList.push(sensor)
        }
    }

    async getSensorList(){
        let sensorList = ""
        if (this.#headerobj?.sensor_list_factored == 1){
            sensorList = await this.getSensorListFromCache()
        }
        else{
            sensorList = this.getSensorListFromDBD()
        }
        this.parseSensorList(sensorList)
    }


    async parseHeader(){
        let header_size = 512;
        let final_byte_offset = 0;
        const headerBlob = this.#fileobj.slice(0,header_size)
        const headerText = await headerBlob.text()
        const lines = headerText.split('\n');
        let n_rows = 5
        for(let i=0; i<n_rows; i++){
            const currentLine = lines[i]
            if(!currentLine) throw new Error("Unexpected end of header!")
            const tag_split = currentLine.split(":") as [string, string]
            final_byte_offset+= currentLine.length + 1
            const tag_key = tag_split[0]
            const tag_val = tag_split[1].trim()
            if (tag_key == "num_ascii_tags"){
                n_rows = parseInt(tag_val)
            }
            (this.#headerobj as Record<string, any>)[tag_key] = tag_val as any
        }
        console.log(this.#headerobj)
        this.#byteState = final_byte_offset
    }

    parseDataRecord(): DBDRecord | null{
        if(this.#byteState >= (this.#dataView?.byteLength as number))
            return null
        const tag = this.#dataView?.getUint8(this.#byteState)
        this.#byteState++
        // console.log(`byte tag = ${tag}`)
        // 88 = X, 100 = d
        if(tag === 88){
            return null
        }
        else if(tag !== 100){
            throw new Error(`Unknown tag ${tag}`)
        }
        if(!this.#headerobj.state_bytes_per_cycle){
            throw new Error("Missing important header info: state_bytes_per_cycle!")
        }

        // let index = 0
        let databytes: number[] = []
        let updates = []
        let mods = []
        let index = 0
        for(let i=0; i < this.#headerobj.state_bytes_per_cycle; i++){
            let byteInt = this.#dataView?.getUint8(this.#byteState) as number
            this.#byteState++
            for(let j=0; j<4; j++){
                if(byteInt & 0x80){
                    databytes.push((this.#sensorList.at(index) as Sensor).bytes)
                    // Data format
                    updates.push(index)
                }
                else if(byteInt & 0x40){
                    mods.push(index)
                }
                byteInt <<= 2
                index++
                if(index >= (this.#headerobj.sensors_per_cycle as number)){
                    break
                }
            }
        }
        let data: (number|null)[] = []
        // console.log(databytes)
        // bytes2format = { 1:'b', 2:'h', 4:'f', 8:'d' }
        for(let dataByte of databytes){
            let data_point: number|null = null
            if(dataByte === 1)
                data_point = this.#dataView?.getInt8(this.#byteState) as number
            else if(dataByte === 2)
                data_point = this.#dataView?.getInt16(this.#byteState, this.#isLittleEndian) as number
            else if(dataByte === 4)
                data_point = this.#dataView?.getFloat32(this.#byteState, this.#isLittleEndian) as number
            else if(dataByte === 8)
                data_point = this.#dataView?.getFloat64(this.#byteState, this.#isLittleEndian) as number
            else
                throw new Error(`dataByte ${dataByte} not valid!`)
            this.#byteState += dataByte
            data.push(data_point)
        }
        return {
            data: data,
            updates: updates,
            mods: mods
        } 
    }
    getCols(cols: string[]): ProcessedRecords {
        let ret: ProcessedRecords = {
            sci_m_present_time: []
        }
        for(let col of cols){
            ret[col] = []
        }
        
        // Get sensor indexs so we don't need to keep looking
        let sm: SensorMap = {}
        for(let sensor_name of Object.keys(ret)){
            sm[sensor_name] = this.#sensorList.findIndex((ele) => {
                return ele.name == sensor_name
            })
        }
        console.log(sm)
        for(let i=0; i<this.dataRecord.length; i++) {
           for(let sensor_name of Object.keys(ret)){
            const update_index = this.dataRecord[i]?.updates.findIndex((ele) => {
                return ele == sm[sensor_name]
            })
            const mod_index = this.dataRecord[i]?.mods.findIndex((ele) => {
                return ele == sm[sensor_name]
            })

            let data = null
            if(update_index != -1){
                data = this.dataRecord[i]?.data[update_index as number]
            }
            else if (mod_index != -1){
                data = ret[sensor_name]?.at(i-1)
            }
            if(sensor_name == "sci_m_present_time"){
                ret.sci_m_present_time.push(new Date((data as number) * 1000))
            }
            else{
                ret[sensor_name]?.push(data as (number | null))
            }
            }
        }
    return ret
    }
    get columns(): string[] {
        return this.#sensorList.map(x => x.name)
    }
}

export class DBDFiles {
    #dbdFiles: FileList = new FileList()
    #cacheFiles: FileList = new FileList()
    processedDBDFiles: DBDFile[] = []
    constructor(dbdFiles: FileList, cacheFiles: FileList) {
        this.#dbdFiles = dbdFiles
        this.#cacheFiles = cacheFiles
    }

    async decode(){
        if(this.#dbdFiles.length > 0){
            for(let dbdFile of this.#dbdFiles){
                const dbdFileObj = new DBDFile(dbdFile, this.#cacheFiles)
                dbdFileObj.decode().then((e)=>{
                    this.processedDBDFiles.push(e)
                })
                // console.log(dbdFileObj.dataRecord)
                // console.log(dbdFileObj.getCols(["m_depth", "m_pitch"]))
            }
        }
    }

    getCols(){
        // get and merge cols
    }
    
}
