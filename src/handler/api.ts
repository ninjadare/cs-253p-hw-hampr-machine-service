import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";
/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {
        const idp = IdentityProviderClient.getInstance();
        if (!idp.validateToken(token))
            {
                throw new Error("{\"statusCode\":401,\"message\":\"Invalid token\"}");
            }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        try
        {
            const machinetable = MachineStateTable.getInstance();
            const machines = machinetable.listMachinesAtLocation(request.locationId);
            const firstavail = machines.find((m) => m.status == MachineStatus.AVAILABLE);
            if (!firstavail) // wasn't able to find a free one
                {
                    return {statusCode: HttpResponseCode.NOT_FOUND};
                }
            machinetable.updateMachineStatus(firstavail.machineId, MachineStatus.AWAITING_DROPOFF);
            machinetable.updateMachineJobId(firstavail.machineId, request.jobId);

            const updatedmachine = machinetable.getMachine(firstavail.machineId); // refresh from database
            if (!updatedmachine) // undef catcher
                {
                    return {statusCode: HttpResponseCode.NOT_FOUND};
                }
            this.cache.put(updatedmachine.machineId, updatedmachine);
               
            return {statusCode: HttpResponseCode.OK, machine: updatedmachine};
        }
        catch (err)
        {
            return {statusCode: HttpResponseCode.BAD_REQUEST};
        }
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        try
        {
            const cachedmachine = this.cache.get(request.machineId);
            if (cachedmachine)
                {
                    return {statusCode: HttpResponseCode.OK, machine: cachedmachine};
                }
            const machinetable = MachineStateTable.getInstance();
            const dbmachine = machinetable.getMachine(request.machineId);
            if (dbmachine)
                {
                    this.cache.put(dbmachine.machineId, dbmachine); // put it in the cache if not already
                    return {statusCode: HttpResponseCode.OK, machine: dbmachine};
                }
                return {statusCode: HttpResponseCode.NOT_FOUND};
        }
        catch (err)
        {
            return {statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR};
        }
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        try
        {
            const machineresponse = this.handleGetMachine(request);
            if (machineresponse.statusCode === HttpResponseCode.NOT_FOUND)
                {
                    return {statusCode: HttpResponseCode.NOT_FOUND};
                }
            if (machineresponse.machine?.status != MachineStatus.AWAITING_DROPOFF)
                {
                    return {statusCode: HttpResponseCode.BAD_REQUEST, machine: machineresponse.machine};
                }
            
            const machinedb = MachineStateTable.getInstance();
            const smartmachine = SmartMachineClient.getInstance();
            smartmachine.startCycle(machineresponse.machine.machineId);
            machinedb.updateMachineStatus(machineresponse.machine.machineId, MachineStatus.RUNNING);

            const updatedmachine = machinedb.getMachine(machineresponse.machine.machineId);
            if (!updatedmachine) // undef catcher
                {
                    return {statusCode: HttpResponseCode.NOT_FOUND};
                }
            this.cache.put(updatedmachine.machineId, updatedmachine);

            return {statusCode: HttpResponseCode.OK, machine: updatedmachine};
        }
        catch (err)
        {
            const machinetable = MachineStateTable.getInstance();
            machinetable.updateMachineStatus(request.machineId, MachineStatus.ERROR);
            const updatedmachine = machinetable.getMachine(request.machineId); // refresh from database
            if (!updatedmachine) // undef catcher
                {
                    return {statusCode: HttpResponseCode.NOT_FOUND};
                }
            this.cache.put(updatedmachine.machineId, updatedmachine);
            return {statusCode: HttpResponseCode.HARDWARE_ERROR, machine: updatedmachine};
        }
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
    }
    
}