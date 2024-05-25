export default class PromiseQueue {
    concurrency: number;
    tasks: any[];
    running: number;
    constructor(concurrency: number) {
        this.concurrency = concurrency;
        this.tasks = [];
        this.running = 0;
    }

    // Add a task to the queue
    enqueue(task: any) {
        this.tasks.push(task);
        this.run();
    }

    waitUntilEmpty(){
        return new Promise<void>((resolve)=>{
            const interval = setInterval(()=>{
                if(this.tasks.length === 0){
                    clearInterval(interval)
                    resolve()
                }
            }, 1000)
        })
    }

    // Run the next task if we're not at max concurrency
    run() {
        while (this.running < this.concurrency && this.tasks.length) {
            this.running++;
            this.tasks.shift()().finally(() => {
                this.running--;
                this.run();
            });
        }
    }
}
